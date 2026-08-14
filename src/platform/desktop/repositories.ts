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
  CreateDocumentWithContentInput,
  CreatePageInput,
  DocumentWriteRepository,
  PageRepository,
  ReplaceDocumentContentInput,
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
import { parseDocumentContent } from "../../domain/validation/documentContent";
import type {
  DocumentOpenCapable,
  DocumentOpenResult,
} from "../../application/queries/DocumentQueryService";
import {
  accessFromWritePolicy,
  isTransientVaultId,
  resolveWritePolicy,
} from "../../application/queries/documentWritePolicy";
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
  deterministicTagColor,
  tagIdOfName,
} from "./vaultMapping";
import { DesktopDocumentSourceCache } from "./DesktopDocumentSourceCache";
import type { DesktopNoteMetadataService } from "./DesktopNoteMetadataService";
import type { DesktopVaultStateClient } from "./DesktopVaultStateClient";
import {
  DesktopMarkdownWriteService,
  mapNoteWriteError,
} from "./DesktopMarkdownWriteService";
import { hydrateDesktopMarkdownAssets } from "./DesktopMarkdownAssetHydrator";
import type { DesktopAssetRegistry } from "./DesktopAssetRegistry";
import {
  DesktopVaultScanCache,
  type VaultScanSnapshot,
} from "./DesktopVaultScanCache";
import type { PortableNoteMetadata } from "../../editor/markdown/types";

export { DesktopVaultScanCache, type VaultScanSnapshot };

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

  constructor(
    private readonly api: E1DesktopAPI,
    private readonly vaultState: DesktopVaultStateClient,
  ) {}

  async list(): Promise<Workspace[]> {
    const recent = await this.api.vault.listRecent();
    // R007 阶段 2：收藏状态逐库取（client 会话内缓存，仅首次真实 IPC）。
    const states = await Promise.all(
      recent.map((vault) => this.vaultState.get(vault.vaultId)),
    );
    return [
      ...recent.map((vault, index) =>
        mapRecentVaultToWorkspace(vault, states[index].workspace.favoriteAt),
      ),
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
  private async trackOpened(opened: OpenedVault): Promise<Workspace> {
    const state = await this.vaultState.get(opened.vaultId);
    const workspace = mapOpenedVaultToWorkspace(
      opened,
      Date.now(),
      state.workspace.favoriteAt,
    );
    if (opened.transient) this.transientWorkspaces.set(workspace.id, workspace);
    return workspace;
  }

  async rename(): Promise<void> {
    throw notImplemented("重命名本地知识库", "后续阶段");
  }

  async update(): Promise<void> {
    throw notImplemented("修改本地知识库信息", "后续阶段");
  }

  /**
   * 收藏/取消收藏（R007 阶段 2）：写 vault-state（设备级，不进 Markdown）。
   * transient 仅预览会话不落盘（client 内存镜像，重启消失）。
   */
  async setFavorite(id: string, favoriteAt: number | null): Promise<void> {
    await this.vaultState.setWorkspaceFavorite(id, favoriteAt);
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

/** 页面仓储：listByWorkspace/listAll 真实（扫描映射 + vault-state 合并）。 */
export class DesktopPageRepository implements PageRepository {
  constructor(
    private readonly api: E1DesktopAPI,
    private readonly scans: DesktopVaultScanCache,
    private readonly metadata: DesktopNoteMetadataService,
    private readonly vaultState: DesktopVaultStateClient,
  ) {}

  async listByWorkspace(vaultId: string): Promise<Page[]> {
    const snapshot = await this.scans.scan(vaultId);
    const state = await this.vaultState.get(vaultId);
    return mapScanEntriesToPages(
      vaultId,
      snapshot.result.entries,
      snapshot.scannedAt,
      this.scans.aliases,
      state,
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

  async create(input: CreatePageInput): Promise<Page> {
    if (input.kind !== "document") {
      throw notImplemented("新建分组", "后续阶段（目录即分组）");
    }
    if (isTransientVaultId(input.workspaceId)) {
      throw new DomainError(
        "VAULT_READ_ONLY",
        "当前知识库处于仅预览模式，E1 不会在这个文件夹中创建文件。",
      );
    }
    const directory = this.resolveCreateDirectory(
      input.workspaceId,
      input.parentId,
    );
    let created;
    try {
      created = await this.api.note.create({
        vaultId: input.workspaceId,
        directory,
        title: input.title.trim() === "" ? "无标题" : input.title,
      });
    } catch (err) {
      mapNoteWriteError(err);
    }
    this.scans.invalidate(input.workspaceId);
    const pages = await this.listByWorkspace(input.workspaceId);
    const found = pages.find((p) => p.id === created.noteId);
    if (found) return found;
    // 扫描偶发未收录时回退合成（仍带稳定 id）。
    const now = Date.now();
    return {
      id: created.noteId,
      workspaceId: input.workspaceId,
      parentId: input.parentId,
      kind: "document",
      title: input.title,
      icon: input.icon ?? null,
      position: pages.length,
      favoriteAt: null,
      lastOpenedAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** parentId → note.create 的 directory（根=""；path:学习 → 学习）。 */
  private resolveCreateDirectory(
    vaultId: string,
    parentId: string | null,
  ): string {
    if (!parentId) return "";
    if (parentId.startsWith("path:")) {
      return parentId.slice("path:".length);
    }
    // 父级是带稳定 id 的文档：新建为其同级（父文件所在目录）。
    const rel = this.scans.getRelativePathSync(vaultId, parentId);
    if (!rel) return "";
    const slash = rel.lastIndexOf("/");
    return slash === -1 ? "" : rel.slice(0, slash);
  }

  /**
   * 重命名（R007 阶段 1，DSK-03）：标题写入 Frontmatter title 键——
   * 乐观锁 + 原子写在 Main 完成；正文与其他 Frontmatter 键逐字节保留；
   * 成功后来源缓存与打开文档的协调器版本同步推进（不假冲突）。
   * 文件名不随标题改动（Title rename ≠ File rename，R007 §4.4）。
   */
  async rename(pageId: string, title: string): Promise<void> {
    await this.metadata.patch(pageId, { title });
  }

  /**
   * 收藏/取消收藏（R007 阶段 2）：写 vault-state 的页面条目——键为
   * stableNoteId（无 id 文档为 path:<relativePath>）；已知 stableNoteId
   * 时顺带清空 Adoption 前的 path 键（键迁移）。设备级状态，不进
   * Markdown；transient 仅预览会话不落盘（client 内存镜像）。
   */
  async setFavorite(pageId: string, favoriteAt: number | null): Promise<void> {
    const target = await this.resolveStateTarget(pageId);
    if (!target) return;
    await this.vaultState.patchPage(
      target.vaultId,
      target.key,
      { favoriteAt },
      target.stalePathKey,
    );
  }

  /**
   * 记录页面浏览时间（R007 阶段 2）：写 vault-state 的 lastOpenedAt——
   * 「最近」列表重启保持。fire-and-forget 非关键路径：写失败只告警
   * 不抛出（与 Web 仓储不同——本地状态丢失可自愈，不应打断打开流程）。
   */
  async setLastOpened(pageId: string, at: number): Promise<void> {
    try {
      const target = await this.resolveStateTarget(pageId);
      if (!target) return;
      await this.vaultState.patchPage(
        target.vaultId,
        target.key,
        { lastOpenedAt: at },
        target.stalePathKey,
      );
    } catch (err) {
      console.warn("记录页面浏览时间失败", err);
    }
  }

  /**
   * pageId → vault-state 写入目标：vaultId + 状态键（stableNoteId 优先，
   * 否则 path:<relativePath>）+ 待清空的 Adoption 前 path 键。
   * 页面不在扫描快照（已删除/未收录）或 transient 会话返回 null（no-op）。
   */
  private async resolveStateTarget(
    pageId: string,
  ): Promise<{ vaultId: string; key: string; stalePathKey?: string } | null> {
    const found = await this.scans.findDocument(pageId);
    if (!found || isTransientVaultId(found.vaultId)) return null;
    const pathKey = `path:${found.entry.relativePath}`;
    if (found.entry.noteId) {
      return { vaultId: found.vaultId, key: found.entry.noteId, stalePathKey: pathKey };
    }
    return { vaultId: found.vaultId, key: pathKey };
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
 * 正文仓储（R006-C3 批次 3 + R006-C4-D）：真实读取 Markdown 正文，
 * 打开时写入 DesktopDocumentSourceCache 供保存 serialize 使用。
 */
export class DesktopContentRepository
  implements ContentRepository, DocumentOpenCapable
{
  private readonly writer: DesktopMarkdownWriteService;

  constructor(
    private readonly api: E1DesktopAPI,
    private readonly scans: DesktopVaultScanCache,
    private readonly sources: DesktopDocumentSourceCache = new DesktopDocumentSourceCache(),
    private readonly codec: MarkdownCodec = createMarkdownCodec(),
    writer?: DesktopMarkdownWriteService,
    private readonly assets?: DesktopAssetRegistry,
  ) {
    this.writer =
      writer ??
      new DesktopMarkdownWriteService(
        api,
        this.sources,
        scans,
        this.codec,
        assets,
      );
  }

  /** 供装配层 / 保存链路读取来源缓存。 */
  getSourceCache(): DesktopDocumentSourceCache {
    return this.sources;
  }

  /** 读取并解析指定页面的 Markdown；找不到扫描条目即页面不存在。 */
  private async readNote(pageId: string): Promise<{
    content: DocumentContent;
    unsupported: UnsupportedMarkdownFeature[];
    stableNoteId: string | null;
    vaultId: string;
    metadata: PortableNoteMetadata;
    lineEnding: "lf" | "crlf";
    hadUtf8Bom: boolean;
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
    const hydrated = this.assets
      ? hydrateDesktopMarkdownAssets({
          vaultId: found.vaultId,
          pageId,
          noteRelativePath: result.relativePath,
          document: parsed.document,
          assets: parsed.assets,
          assetsDirectory: this.scans.getAssetsDirectorySync(found.vaultId),
          registry: this.assets,
        }).document
      : parsed.document;
    const metadata: PortableNoteMetadata = {
      id: parsed.metadata.id,
      title: parsed.metadata.title,
      tags: parsed.metadata.tags,
      createdAt: parsed.metadata.createdAt,
      updatedAt: parsed.metadata.updatedAt,
      aliases: parsed.metadata.aliases,
      extra: parsed.metadata.extra,
    };
    return {
      content: {
        pageId,
        workspaceId: found.vaultId,
        contentJson: hydrated,
        textSnapshot: jsonToText(parsed.document),
        version: result.versionToken,
        updatedAt: result.source.modifiedAt,
      },
      unsupported: parsed.unsupported,
      stableNoteId: result.stableNoteId,
      vaultId: found.vaultId,
      metadata,
      lineEnding: parsed.lineEnding,
      hadUtf8Bom: result.hadUtf8Bom ?? false,
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
   * 打开语义（R006-C3 FR-17/19 + R006-C4 FR-02/03/19）：
   * 计算 writePolicy，并写入 Source Context 缓存供后续保存使用。
   */
  async openDocument(pageId: string): Promise<DocumentOpenResult> {
    const {
      content,
      unsupported,
      stableNoteId,
      vaultId,
      metadata,
      lineEnding,
      hadUtf8Bom,
      source,
    } = await this.readNote(pageId);
    const lossy = unsupported.length > 0;
    const writePolicy = resolveWritePolicy({
      transient: isTransientVaultId(vaultId),
      lossy,
      stableNoteId,
    });
    this.sources.set(pageId, {
      vaultId,
      sessionPageId: pageId,
      relativePath: source.relativePath,
      stableNoteId,
      metadata,
      frontmatterExtra: metadata.extra ?? [],
      lineEnding,
      hadUtf8Bom,
      versionToken: content.version,
      compatibility: { lossy, unsupported },
      writeSession: {
        sourceLossyApproved: false,
        outputLossyApproved: false,
        identityAdoptionApproved: false,
      },
    });
    return {
      content,
      access: accessFromWritePolicy(writePolicy),
      writePolicy,
      compatibility: { lossy, unsupported },
      source: { ...source, versionToken: content.version },
    };
  }

  /**
   * ContentRepository.save（R006-C4.1 FR-03）：校验后委托统一写入服务。
   */
  async save(
    pageId: string,
    contentJson: unknown,
    _textSnapshot: string,
    expectedVersion: string,
  ): Promise<{ version: string; updatedAt: number }> {
    const parsed = parseDocumentContent(contentJson);
    if (!parsed.ok) {
      throw new DomainError(
        "CORRUPTED_DOCUMENT",
        "正文 JSON 未通过白名单校验",
      );
    }
    const result = await this.writer.save({
      pageId,
      contentJson: parsed.value,
      expectedVersionToken: expectedVersion,
      mode: "autosave",
    });
    return { version: result.versionToken, updatedAt: result.updatedAt };
  }

  async listAll(): Promise<DocumentContent[]> {
    return [];
  }

  async listByWorkspace(): Promise<DocumentContent[]> {
    return [];
  }
}

/** 标签仓储：从扫描条目的 Frontmatter tags 聚合；setPageTags 写回 Frontmatter。 */
export class DesktopTagRepository implements TagRepository {
  constructor(
    private readonly scans: DesktopVaultScanCache,
    private readonly metadata: DesktopNoteMetadataService,
  ) {}

  async listByWorkspace(vaultId: string): Promise<Tag[]> {
    const snapshot = await this.scans.scan(vaultId);
    return mapScanEntriesToTags(
      vaultId,
      snapshot.result.entries,
      this.scans.aliases,
    ).tags;
  }

  async listWorkspacePageTags(vaultId: string): Promise<PageTag[]> {
    const snapshot = await this.scans.scan(vaultId);
    return mapScanEntriesToTags(
      vaultId,
      snapshot.result.entries,
      this.scans.aliases,
    ).pageTags;
  }

  /** 单页标签 id：在已缓存的扫描快照中按页面 id 反查（TagPicker 用）。 */
  async listPageTagIds(pageId: string): Promise<string[]> {
    const entry = await this.scans.findEntryByPageId(pageId);
    return entry ? entry.tags.map(tagIdOfName) : [];
  }

  /**
   * 新建标签（R007 阶段 1 §1.5）：「创建」即得到一个可勾选的新字符串
   * 标签——持久化发生在随后的 setPageTags（写入引用它的文档
   * Frontmatter）；此处不产生任何文件写。颜色按名称确定性派生
   * （Tag.color 是 E1 本地元数据，不进 Markdown）。
   */
  async create(workspaceId: string, name: string): Promise<Tag> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new DomainError("INVALID_INPUT", "标签名不能为空。");
    }
    return {
      id: tagIdOfName(trimmed),
      workspaceId,
      name: trimmed,
      color: deterministicTagColor(trimmed),
    };
  }

  async remove(): Promise<void> {
    throw notImplemented("删除标签", "后续阶段（R007 阶段 4 批量写）");
  }

  /**
   * 覆盖式设置页面标签（R007 阶段 1）：tag:<name> id 还原为名称后写入
   * Frontmatter tags（乐观锁 + 原子写在 Main；来源缓存与协调器版本由
   * metadata service 同步推进）。
   */
  async setPageTags(pageId: string, tagIds: string[]): Promise<void> {
    const names = tagIds.map((id) =>
      id.startsWith("tag:") ? id.slice("tag:".length) : id,
    );
    await this.metadata.patch(pageId, { tags: names });
  }
}

/**
 * 原子文档写（R006-C4-G / C4.1）：createWithContent → note.create；
 * replaceContent 经 DesktopMarkdownWriteService（不得绕过 Gate）。
 */
export class DesktopDocumentWriteRepository implements DocumentWriteRepository {
  private readonly codec: MarkdownCodec;
  private readonly writer: DesktopMarkdownWriteService;

  constructor(
    private readonly api: E1DesktopAPI,
    private readonly scans: DesktopVaultScanCache,
    private readonly sources: DesktopDocumentSourceCache,
    codec?: MarkdownCodec,
    writer?: DesktopMarkdownWriteService,
  ) {
    this.codec = codec ?? createMarkdownCodec();
    this.writer =
      writer ??
      new DesktopMarkdownWriteService(api, sources, scans, this.codec);
  }

  async createWithContent(input: CreateDocumentWithContentInput): Promise<Page> {
    if (isTransientVaultId(input.workspaceId)) {
      throw new DomainError(
        "VAULT_READ_ONLY",
        "当前知识库处于仅预览模式，E1 不会在这个文件夹中创建文件。",
      );
    }
    const parsed = parseDocumentContent(input.contentJson);
    if (!parsed.ok) {
      throw new DomainError(
        "CORRUPTED_DOCUMENT",
        "初始正文 JSON 未通过白名单校验",
      );
    }
    const noteId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `id-${Date.now().toString(36)}`;
    const nowIso = new Date().toISOString();
    const title = input.title.trim() === "" ? "无标题" : input.title;
    const serialized = await this.codec.serialize({
      document: parsed.value,
      metadata: {
        id: noteId,
        title,
        tags: [],
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      assetResolver: {
        resolveAssetPath: ({ name, kind }) =>
          `assets/${kind}-${name || "file"}`,
      },
      mode: "portable",
      lineEnding: "lf",
    });

    const directory = this.resolveCreateDirectory(
      input.workspaceId,
      input.parentId,
    );
    let created;
    try {
      created = await this.api.note.create({
        vaultId: input.workspaceId,
        directory,
        title,
        markdown: serialized.markdown,
      });
    } catch (err) {
      mapNoteWriteError(err);
    }

    this.scans.invalidate(input.workspaceId);
    const pages = await this.scans.scan(input.workspaceId).then((snap) =>
      mapScanEntriesToPages(
        input.workspaceId,
        snap.result.entries,
        snap.scannedAt,
        this.scans.aliases,
      ),
    );
    const found = pages.find((p) => p.id === created.noteId);
    if (found) return found;
    const now = Date.now();
    return {
      id: created.noteId,
      workspaceId: input.workspaceId,
      parentId: input.parentId,
      kind: "document",
      title,
      icon: input.icon ?? null,
      position: pages.length,
      favoriteAt: null,
      lastOpenedAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async replaceContent(
    input: ReplaceDocumentContentInput,
  ): Promise<DocumentContent> {
    const parsed = parseDocumentContent(input.contentJson);
    if (!parsed.ok) {
      throw new DomainError(
        "CORRUPTED_DOCUMENT",
        "正文 JSON 未通过白名单校验",
      );
    }
    const ctx = this.sources.get(input.pageId);
    const result = await this.writer.save({
      pageId: input.pageId,
      contentJson: parsed.value,
      expectedVersionToken: ctx?.versionToken ?? "",
      mode: "replace-content",
    });
    const latest = this.sources.get(input.pageId);
    return {
      pageId: input.pageId,
      workspaceId: latest?.vaultId ?? ctx?.vaultId ?? "",
      contentJson: parsed.value,
      textSnapshot: input.textSnapshot,
      version: result.versionToken,
      updatedAt: result.updatedAt,
    };
  }

  private resolveCreateDirectory(
    vaultId: string,
    parentId: string | null,
  ): string {
    if (!parentId) return "";
    if (parentId.startsWith("path:")) {
      return parentId.slice("path:".length);
    }
    const rel = this.scans.getRelativePathSync(vaultId, parentId);
    if (!rel) return "";
    const slash = rel.lastIndexOf("/");
    return slash === -1 ? "" : rel.slice(0, slash);
  }
}
