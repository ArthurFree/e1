/**
 * R006 阶段 2（C2）：Desktop 仓储适配——domain port 的 IPC-backed 实现。
 *
 * 读路径真实（vault:listRecent / vault:openRecent / vault:scan / note.read），
 * 写路径诚实失败：全部写操作抛 DomainError("NOT_IMPLEMENTED")（中文文案
 * 注明对应阶段），不静默成功、不写任何文件（US-01：首次打开不修改原文件）。
 * 对应阶段：note.create/save 属 C4，附件属阶段 5，重新定位属阶段 6
 * （见 docs/requirements/r006.md 与 r006-c3.md）。
 *
 * R006-C2.1（FR-01/02/03）：授权边界收口——Renderer 不再接触 absolutePath；
 * 已初始化目录经 vault.openRecent 打开；未初始化目录挂起授权令牌并抛
 * DomainError("VAULT_CONFIRMATION_REQUIRED")，用户确认（仅预览/初始化）
 * 后经 platform/desktop/vaultOpenConfirmation 握手重进 create，再调
 * vault.openSelection 完成；「仅预览」产生 transient 会话知识库（名称加
 * 「（预览）」后缀，不写注册表、重启消失）。
 *
 * 每个仓储经构造函数接收 E1DesktopAPI（由 createDesktopRuntime 注入），
 * 不直接访问 window.e1（架构门禁允许，但注入更便于单测）。
 */
import { DomainError } from "../../domain/errors";
import type {
  ContentRepository,
  PageRepository,
  TagRepository,
  WorkspaceRepository,
} from "../../domain/repositories";
import type {
  DocumentContent,
  Page,
  PageTag,
  Tag,
  Workspace,
} from "../../domain/types";
import type {
  DocumentOpenCapable,
  DocumentOpenResult,
} from "../../application/queries/DocumentQueryService";
import { createMarkdownCodec } from "../../editor/markdown/codec";
import type {
  MarkdownCodec,
  UnsupportedMarkdownFeature,
} from "../../editor/markdown/types";
import { jsonToText } from "../../editor/markdown";
import type {
  E1DesktopAPI,
  OpenedVault,
  ReadNoteResult,
  VaultScanEntry,
  VaultScanResult,
} from "./desktopApi";
import { DesktopIpcError } from "./desktopApi";
import {
  stashPendingVaultSelection,
  takePendingVaultDecision,
} from "./vaultOpenConfirmation";
import {
  mapOpenedVaultToWorkspace,
  mapRecentVaultToWorkspace,
  mapScanEntriesToPages,
  mapScanEntriesToTags,
  pageIdOfEntry,
  tagIdOfName,
} from "./vaultMapping";

/** 一次扫描的快照：条目 + 扫描时刻（页面 createdAt/updatedAt 取它）。 */
export interface VaultScanSnapshot {
  result: VaultScanResult;
  scannedAt: number;
}

/**
 * 工作区级扫描缓存：同一会话内对同一 vaultId 只扫描一次。
 * R006-C3（FR-14）：新增失效/重扫/按页面 id 反查能力——写路径接通
 * （C4）与「重新扫描知识库」（批次 4）依赖 invalidate/rescan；
 * findDocument 是正文读取链路 pageId → vaultId + relativePath 的桥梁。
 */
export class DesktopVaultScanCache {
  private readonly snapshots = new Map<string, Promise<VaultScanSnapshot>>();

  constructor(private readonly api: E1DesktopAPI) {}

  /** 扫描（或取缓存）指定 Vault；并发调用共享同一 Promise。 */
  scan(vaultId: string): Promise<VaultScanSnapshot> {
    let pending = this.snapshots.get(vaultId);
    if (!pending) {
      pending = this.api.vault
        .scan(vaultId)
        .then((result) => ({ result, scannedAt: Date.now() }));
      this.snapshots.set(vaultId, pending);
      // 扫描失败（如目录中途被移走）不缓存拒绝态，下次调用重试。
      pending.catch(() => this.snapshots.delete(vaultId));
    }
    return pending;
  }

  /** 使指定 Vault 的缓存失效（FR-14；重新扫描与 C4 写路径用）。 */
  invalidate(vaultId: string): void {
    this.snapshots.delete(vaultId);
  }

  /** 全部缓存失效（如 Vault 列表整体刷新）。 */
  invalidateAll(): void {
    this.snapshots.clear();
  }

  /** 强制重新扫描（跳过缓存并以新快照替换；失败时保留语义同 scan）。 */
  rescan(vaultId: string): Promise<VaultScanSnapshot> {
    this.invalidate(vaultId);
    return this.scan(vaultId);
  }

  /**
   * 按页面 id 在已缓存的扫描快照中反查所属 Vault 与条目（FR-14）。
   * id 派生规则与 vaultMapping 共用同一 pageIdOfEntry（Frontmatter noteId
   * 优先，否则 "path:" + relativePath），两处不会漂移。
   */
  async findDocument(
    pageId: string,
  ): Promise<{ vaultId: string; entry: VaultScanEntry } | null> {
    for (const [vaultId, pending] of this.snapshots) {
      const snapshot = await pending.catch(() => null);
      if (!snapshot) continue;
      const entry = snapshot.result.entries.find(
        (e) => e.kind === "document" && pageIdOfEntry(e) === pageId,
      );
      if (entry) return { vaultId, entry };
    }
    return null;
  }

  /** 在已缓存的扫描快照中按页面 id 找条目（listPageTagIds 用）。 */
  async findEntryByPageId(pageId: string): Promise<VaultScanEntry | null> {
    const found = await this.findDocument(pageId);
    return found?.entry ?? null;
  }
}

/** 写路径统一失败：中文文案注明对应阶段，诚实失败优于静默。 */
function notImplemented(feature: string, stage: string): DomainError {
  return new DomainError(
    "NOT_IMPLEMENTED",
    `桌面端暂不支持${feature}（将在 R006 ${stage}支持）。`,
  );
}

/**
 * 知识库仓储：list 映射最近 Vault 列表并合并会话内 transient（仅预览）
 * 知识库；create 复用原生目录选择（US-02 新建与 US-01 打开同一条
 * 「选目录 → 确认 → 初始化/预览/打开」流程）。
 */
export class DesktopWorkspaceRepository implements WorkspaceRepository {
  /**
   * 会话内 transient（仅预览）知识库：vaultId → Workspace。
   * 不写注册表、重启消失（FR-03「仅预览」）；仅本进程 create 产生。
   */
  private readonly transientWorkspaces = new Map<string, Workspace>();

  constructor(private readonly api: E1DesktopAPI) {}

  async list(): Promise<Workspace[]> {
    const recent = await this.api.vault.listRecent();
    return [
      ...recent.map(mapRecentVaultToWorkspace),
      ...this.transientWorkspaces.values(),
    ];
  }

  /**
   * 打开本地知识库（R006-C2.1 两段式）：
   * 1. 正常进入：弹原生目录选择——取消抛 DomainError("CANCELLED")；
   *    已初始化目录经 vault.openRecent 打开；未初始化目录挂起授权令牌并抛
   *    DomainError("VAULT_CONFIRMATION_REQUIRED")（FR-03 确认框由侧栏接住）；
   * 2. 用户确认后重进：takePendingVaultDecision() 消费决定，调
   *    vault.openSelection（initialize=false 仅预览 / true 初始化并打开）。
   * name 入参被忽略——本地 Vault 的名称取自 vault.json / 目录 basename，
   * Web 的「输入名称新建」语义在桌面由目录名承担（见 r006 §5 US-02）。
   */
  async create(name: string): Promise<Workspace> {
    void name;
    const decision = takePendingVaultDecision();
    if (decision) {
      const opened = await this.api.vault.openSelection({
        selectionToken: decision.selectionToken,
        initialize: decision.initialize,
      });
      return this.trackOpened(opened);
    }
    const selected = await this.api.vault.selectDirectory();
    if (!selected) {
      throw new DomainError("CANCELLED", "已取消选择本地目录。");
    }
    if (selected.initialized && selected.vaultId) {
      const opened = await this.api.vault.openRecent({
        vaultId: selected.vaultId,
      });
      return this.trackOpened(opened);
    }
    // 未初始化：挂起令牌，抛待确认信号（displayName 经握手模块供确认框展示）。
    stashPendingVaultSelection({
      selectionToken: selected.selectionToken,
      displayName: selected.displayName,
    });
    throw new DomainError(
      "VAULT_CONFIRMATION_REQUIRED",
      `文件夹「${selected.displayName}」尚未初始化为 E1 知识库。`,
    );
  }

  /** 打开结果 → Workspace；transient 会话记入会话内列表（list 合并用）。 */
  private trackOpened(opened: OpenedVault): Workspace {
    const workspace = mapOpenedVaultToWorkspace(opened, Date.now());
    if (opened.transient) this.transientWorkspaces.set(workspace.id, workspace);
    return workspace;
  }

  async rename(): Promise<void> {
    throw notImplemented("重命名本地知识库", "后续阶段");
  }

  async update(): Promise<void> {
    throw notImplemented("修改本地知识库信息", "后续阶段");
  }

  async setFavorite(): Promise<void> {
    throw notImplemented("收藏本地知识库", "后续阶段");
  }

  /**
   * 记录最近打开：经 vault.openRecent 的 touch 语义刷新注册表排序（US-06）。
   * transient（仅预览）知识库不进注册表，no-op。
   * 目录不可访问等失败只告警不抛出——本方法是 fire-and-forget 的
   * 非关键路径，失败不影响已进入的会话。
   */
  async setLastOpened(id: string): Promise<void> {
    if (this.transientWorkspaces.has(id)) return;
    try {
      await this.api.vault.openRecent({ vaultId: id });
    } catch (err) {
      console.warn("刷新最近 Vault 记录失败", err);
    }
  }
}

/** 页面仓储：listByWorkspace/listAll 真实（扫描映射），其余写操作抛错。 */
export class DesktopPageRepository implements PageRepository {
  constructor(
    private readonly api: E1DesktopAPI,
    private readonly scans: DesktopVaultScanCache,
  ) {}

  async listByWorkspace(vaultId: string): Promise<Page[]> {
    const snapshot = await this.scans.scan(vaultId);
    return mapScanEntriesToPages(
      vaultId,
      snapshot.result.entries,
      snapshot.scannedAt,
    );
  }

  /**
   * 跨知识库全部页面（活动/收藏等全局视图用）：逐最近 Vault 扫描（经缓存），
   * 不可访问/扫描失败的库跳过并告警，不让单库故障拖垮全局视图。
   */
  async listAll(): Promise<Page[]> {
    const recent = await this.api.vault.listRecent();
    const pages: Page[] = [];
    for (const vault of recent) {
      if (!vault.accessible) continue;
      try {
        pages.push(...(await this.listByWorkspace(vault.vaultId)));
      } catch (err) {
        console.warn(`扫描 Vault「${vault.displayName}」失败，已跳过`, err);
      }
    }
    return pages;
  }

  async create(): Promise<Page> {
    throw notImplemented("新建页面", "阶段 3（note.create）");
  }

  async rename(): Promise<void> {
    throw notImplemented("重命名页面", "后续阶段（标题与文件名解耦，r006 §8）");
  }

  async setFavorite(): Promise<void> {
    throw notImplemented("收藏页面", "后续阶段");
  }

  /**
   * 记录页面浏览时间：no-op——桌面端「最近」排序由 vault.openRecent 的
   * 注册表 touch 承担（工作区粒度），页面粒度浏览记录不落盘（C3 全程
   * 只读，不写 vault.json）；会话内排序由 WorkspaceProvider 的本地镜像
   * 更新。此前抛 NOT_IMPLEMENTED 会让 MainArea 的 markOpened 产生
   * unhandled rejection（fire-and-forget 非关键路径，不应失败）。
   */
  async setLastOpened(): Promise<void> {
    // no-op（见上注释）。
  }

  async move(): Promise<void> {
    throw notImplemented(
      "拖拽移动页面",
      "后续阶段（桌面端拖拽排序暂时关闭，r006 §8）",
    );
  }

  async remove(): Promise<void> {
    throw notImplemented("删除页面", "后续阶段（r006：删除禁用）");
  }

  async restore(): Promise<void> {
    throw notImplemented("恢复页面", "后续阶段");
  }

  async purge(): Promise<void> {
    throw notImplemented("彻底删除页面", "后续阶段");
  }

  async purgeTrashed(): Promise<void> {
    throw notImplemented("清空回收站", "后续阶段");
  }
}

/**
 * note.read 的 IPC 错误 → DomainError（R006-C3 §37：Main → IpcResult →
 * preload → DesktopIpcError → DomainError，原始 Electron Error 不穿透 UI）。
 * UI（MainArea 错误块）按 DomainError.code 分流标题/说明/按钮；
 * DOCUMENT_TOO_LARGE 的 { sizeBytes, maxBytes } 经 details 透传。
 */
function mapNoteReadError(err: unknown): never {
  if (err instanceof DesktopIpcError) {
    switch (err.code) {
      case "NOTE_NOT_FOUND":
        throw new DomainError(
          "PAGE_NOT_FOUND",
          "这篇笔记已经不存在。它可能已经被其他程序移动或删除。",
        );
      case "VAULT_NOT_FOUND":
        throw new DomainError(
          "WORKSPACE_NOT_FOUND",
          "知识库目录不可访问，无法读取该笔记。",
        );
      case "NOTE_PERMISSION_DENIED":
        throw new DomainError(
          "NOTE_PERMISSION_DENIED",
          "无法读取该 Markdown，请检查当前系统用户是否具有该文件的读取权限。",
        );
      case "NOTE_IO_ERROR":
        throw new DomainError(
          "NOTE_IO_ERROR",
          "读取 Markdown 时发生系统错误，文件本身没有被修改。",
        );
      case "DOCUMENT_TOO_LARGE":
        throw new DomainError(
          "DOCUMENT_TOO_LARGE",
          "这篇 Markdown 文件过大，当前版本暂不支持直接打开。",
          err.details,
        );
      case "UNSUPPORTED_ENCODING":
        throw new DomainError(
          "UNSUPPORTED_ENCODING",
          "当前文件可能不是 UTF-8 编码，E1 暂时无法安全打开该 Markdown。",
        );
      default:
        throw err;
    }
  }
  throw err;
}

/**
 * 正文仓储（R006-C3 批次 3，FR-13/15/17/18）：真实读取 Markdown 正文。
 * 链路：pageId → 扫描缓存反查（vaultId + relativePath）→ note.read →
 * MarkdownCodec.parse（codec 内部做 CRLF→LF 归一并剥离 Frontmatter）→
 * DocumentContent。全程只读：不写 id、不改 Frontmatter、不产生任何写盘
 * （PR-02/03）。
 * 同时实现 DocumentOpenCapable：openDocument 透出访问级别（含不支持语法
 * 时 read-only）、兼容性明细与来源信息（FR-17/19）。
 * save/listAll/listByWorkspace 保持批次 2 语义（保存属 C4；正文不进入
 * 搜索索引，Desktop 搜索维持标题搜索，§35）。
 */
export class DesktopContentRepository
  implements ContentRepository, DocumentOpenCapable
{
  constructor(
    private readonly api: E1DesktopAPI,
    private readonly scans: DesktopVaultScanCache,
    private readonly codec: MarkdownCodec = createMarkdownCodec(),
  ) {}

  /** 读取并解析指定页面的 Markdown；找不到扫描条目即页面不存在。 */
  private async readNote(pageId: string): Promise<{
    content: DocumentContent;
    unsupported: UnsupportedMarkdownFeature[];
    source: { relativePath: string; modifiedAt: number; sizeBytes: number };
  }> {
    const found = await this.scans.findDocument(pageId);
    if (!found) {
      throw new DomainError(
        "PAGE_NOT_FOUND",
        "这篇笔记已经不存在。它可能已经被其他程序移动或删除。",
      );
    }
    let result: ReadNoteResult;
    try {
      result = await this.api.note.read({
        vaultId: found.vaultId,
        relativePath: found.entry.relativePath,
      });
    } catch (err) {
      throw mapNoteReadError(err);
    }
    const parsed = await this.codec.parse({
      markdown: result.markdown,
      relativePath: result.relativePath,
    });
    return {
      content: {
        pageId,
        workspaceId: found.vaultId,
        contentJson: parsed.document,
        textSnapshot: jsonToText(parsed.document),
        version: result.versionToken,
        updatedAt: result.source.modifiedAt,
      },
      unsupported: parsed.unsupported,
      source: {
        relativePath: result.relativePath,
        modifiedAt: result.source.modifiedAt,
        sizeBytes: result.source.sizeBytes,
      },
    };
  }

  /** ContentRepository.get：真实读取（不存在/读取失败抛 DomainError）。 */
  async get(pageId: string): Promise<DocumentContent | undefined> {
    return (await this.readNote(pageId)).content;
  }

  /**
   * 打开语义（FR-17/19）：检出无法无损往返的语法（unsupported 非空）时
   * 以 read-only 打开——「无法确认无损 → 默认只读」（PR-04）。
   */
  async openDocument(pageId: string): Promise<DocumentOpenResult> {
    const { content, unsupported, source } = await this.readNote(pageId);
    const lossy = unsupported.length > 0;
    return {
      content,
      access: lossy ? "read-only" : "editable",
      compatibility: { lossy, unsupported },
      source: { ...source, versionToken: content.version },
    };
  }

  async save(): Promise<{ version: string; updatedAt: number }> {
    throw notImplemented("保存文档", "阶段 4（note.save）");
  }

  async listAll(): Promise<DocumentContent[]> {
    return [];
  }

  async listByWorkspace(): Promise<DocumentContent[]> {
    return [];
  }
}

/** 标签仓储：从扫描条目的 Frontmatter tags 聚合；写操作抛错。 */
export class DesktopTagRepository implements TagRepository {
  constructor(private readonly scans: DesktopVaultScanCache) {}

  async listByWorkspace(vaultId: string): Promise<Tag[]> {
    const snapshot = await this.scans.scan(vaultId);
    return mapScanEntriesToTags(vaultId, snapshot.result.entries).tags;
  }

  async listWorkspacePageTags(vaultId: string): Promise<PageTag[]> {
    const snapshot = await this.scans.scan(vaultId);
    return mapScanEntriesToTags(vaultId, snapshot.result.entries).pageTags;
  }

  /** 单页标签 id：在已缓存的扫描快照中按页面 id 反查（TagPicker 用）。 */
  async listPageTagIds(pageId: string): Promise<string[]> {
    const entry = await this.scans.findEntryByPageId(pageId);
    return entry ? entry.tags.map(tagIdOfName) : [];
  }

  async create(): Promise<Tag> {
    throw notImplemented("新建标签", "后续阶段");
  }

  async remove(): Promise<void> {
    throw notImplemented("删除标签", "后续阶段");
  }

  async setPageTags(): Promise<void> {
    throw notImplemented(
      "设置页面标签",
      "后续阶段（Frontmatter 回写属阶段 3+）",
    );
  }
}
