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
import { DesktopDocumentSourceCache } from "./DesktopDocumentSourceCache";
import type { PortableNoteMetadata } from "../../editor/markdown/types";

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
  /** 同步 pageId → relativePath（供 mention 解析；随 scan 结果更新）。 */
  private readonly pageRelativePaths = new Map<string, string>();

  constructor(private readonly api: E1DesktopAPI) {}

  /** 扫描（或取缓存）指定 Vault；并发调用共享同一 Promise。 */
  scan(vaultId: string): Promise<VaultScanSnapshot> {
    let pending = this.snapshots.get(vaultId);
    if (!pending) {
      pending = this.api.vault.scan(vaultId).then((result) => {
        for (const entry of result.entries) {
          if (entry.kind === "document") {
            this.pageRelativePaths.set(pageIdOfEntry(entry), entry.relativePath);
          }
        }
        return { result, scannedAt: Date.now() };
      });
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
    this.pageRelativePaths.clear();
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

  /** 同步取页面相对路径（mention 解析；未扫描到返回 null）。 */
  getRelativePathSync(pageId: string): string | null {
    return this.pageRelativePaths.get(pageId) ?? null;
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
    const directory = this.resolveCreateDirectory(input.parentId);
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
  private resolveCreateDirectory(parentId: string | null): string {
    if (!parentId) return "";
    if (parentId.startsWith("path:")) {
      return parentId.slice("path:".length);
    }
    // 父级是带稳定 id 的文档：新建为其同级（父文件所在目录）。
    const rel = this.scans.getRelativePathSync(parentId);
    if (!rel) return "";
    const slash = rel.lastIndexOf("/");
    return slash === -1 ? "" : rel.slice(0, slash);
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
 * 正文仓储（R006-C3 批次 3 + R006-C4-D）：真实读取 Markdown 正文，
 * 打开时写入 DesktopDocumentSourceCache 供保存 serialize 使用。
 */
export class DesktopContentRepository
  implements ContentRepository, DocumentOpenCapable
{
  constructor(
    private readonly api: E1DesktopAPI,
    private readonly scans: DesktopVaultScanCache,
    private readonly sources: DesktopDocumentSourceCache = new DesktopDocumentSourceCache(),
    private readonly codec: MarkdownCodec = createMarkdownCodec(),
  ) {}

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
        contentJson: parsed.document,
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
   * ContentRepository.save（R006-C4-E FR-30）：
   * SourceCache → serialize → lossy gate → note.save → 更新 versionToken。
   */
  async save(
    pageId: string,
    contentJson: unknown,
    _textSnapshot: string,
    expectedVersion: string,
  ): Promise<{ version: string; updatedAt: number }> {
    const ctx = this.sources.get(pageId);
    if (!ctx) {
      throw new DomainError(
        "PAGE_NOT_FOUND",
        "文档来源上下文已失效，请重新打开该笔记后再保存。",
      );
    }
    // 有损来源未确认 / 身份未 Adoption：拒绝自动保存。
    if (
      ctx.compatibility.lossy &&
      !ctx.writeSession.sourceLossyApproved
    ) {
      throw new DomainError(
        "MARKDOWN_LOSSY_OUTPUT",
        "当前 Markdown 包含 E1 暂不完全支持的格式，请先确认了解风险后再保存。",
        { phase: "source", unsupported: ctx.compatibility.unsupported },
      );
    }
    if (
      !ctx.stableNoteId &&
      !ctx.writeSession.identityAdoptionApproved
    ) {
      throw new DomainError(
        "MARKDOWN_LOSSY_OUTPUT",
        "这篇 Markdown 尚未建立稳定笔记身份，请先启用编辑后再保存。",
        { phase: "identity-adoption" },
      );
    }

    const metadata: PortableNoteMetadata = {
      ...ctx.metadata,
      id: ctx.stableNoteId ?? ctx.metadata.id,
      // FR-20：只更新 updated；title/tags/created/aliases/extra 保留。
      updatedAt: new Date().toISOString(),
      extra: ctx.frontmatterExtra,
    };

    const serialized = await this.codec.serialize({
      document: contentJson,
      metadata,
      assetResolver: {
        resolveAssetPath: ({ name, kind }) =>
          // C4 无真实 AssetStore：生成相对占位；localImage/attachment 节点
          // 会在 transform 中记 unsupported → lossy gate。
          `assets/${kind}-${name || "file"}`,
      },
      mode: "portable",
      lineEnding: ctx.lineEnding,
      resolveMentionPath: (targetPageId) =>
        this.resolveMentionRelativePath(ctx.relativePath, targetPageId),
    });

    if (serialized.lossy && !ctx.writeSession.outputLossyApproved) {
      throw new DomainError(
        "MARKDOWN_LOSSY_OUTPUT",
        "当前内容包含 Markdown 无法完整表达的格式，自动保存已暂停。",
        { phase: "output", unsupported: serialized.unsupported },
      );
    }

    let saved;
    try {
      saved = await this.api.note.save({
        vaultId: ctx.vaultId,
        relativePath: ctx.relativePath,
        markdown: serialized.markdown,
        expectedVersionToken: expectedVersion,
      });
    } catch (err) {
      throw mapNoteWriteError(err);
    }

    this.sources.updateVersion(pageId, saved.versionToken);
    // 同步 metadata.updatedAt 到缓存，供下次 serialize。
    const latest = this.sources.get(pageId);
    if (latest) {
      this.sources.set(pageId, {
        ...latest,
        metadata: { ...latest.metadata, updatedAt: metadata.updatedAt },
        versionToken: saved.versionToken,
      });
    }
    return {
      version: saved.versionToken,
      updatedAt: saved.source?.modifiedAt ?? Date.now(),
    };
  }

  /** 当前文档相对路径 → 目标页相对路径（同 Vault）；无法解析返回 null。 */
  private resolveMentionRelativePath(
    fromRelativePath: string,
    targetPageId: string,
  ): string | null {
    const target = this.scans.getRelativePathSync(targetPageId);
    if (!target) return null;
    return relativeMarkdownPath(fromRelativePath, target);
  }

  async listAll(): Promise<DocumentContent[]> {
    return [];
  }

  async listByWorkspace(): Promise<DocumentContent[]> {
    return [];
  }
}

/**
 * note.save 的 IPC 错误 → DomainError（R006-C4 FR-10/11/15）。
 */
function mapNoteWriteError(err: unknown): never {
  if (err instanceof DesktopIpcError) {
    switch (err.code) {
      case "DOCUMENT_CONFLICT":
        throw new DomainError(
          "DOCUMENT_CONFLICT",
          "这篇笔记已在 E1 之外发生修改，为了避免覆盖外部修改，自动保存已暂停。",
          err.details,
        );
      case "VAULT_READ_ONLY":
        throw new DomainError(
          "VAULT_READ_ONLY",
          "当前知识库处于仅预览模式，E1 不会修改这个文件夹中的任何内容。",
        );
      case "NOTE_WRITE_PERMISSION_DENIED":
        throw new DomainError(
          "NOTE_WRITE_PERMISSION_DENIED",
          "无法保存 Markdown，当前系统用户没有该文件的写入权限。你的编辑内容仍保留在当前应用中。",
        );
      case "NOTE_WRITE_IO_ERROR":
        throw new DomainError(
          "NOTE_WRITE_IO_ERROR",
          "保存 Markdown 时发生系统错误，原文件没有被主动清空。",
        );
      case "DOCUMENT_TOO_LARGE":
        throw new DomainError(
          "DOCUMENT_TOO_LARGE",
          "这篇 Markdown 序列化结果过大，当前版本暂不支持保存。",
          err.details,
        );
      case "NOTE_NOT_FOUND":
        throw new DomainError(
          "PAGE_NOT_FOUND",
          "这篇笔记已经不存在。它可能已经被其他程序移动或删除。",
        );
      case "PATH_ESCAPE":
      case "INVALID_INPUT":
        throw new DomainError("INVALID_INPUT", err.message);
      default:
        throw err;
    }
  }
  throw err;
}

/**
 * 从 from 文件到 to 文件的相对 Markdown 链接路径（posix 风格）。
 * 例：学习/a.md → 学习/b.md => b.md；学习/a.md → 根/c.md => ../c.md。
 */
export function relativeMarkdownPath(fromFile: string, toFile: string): string {
  const fromParts = fromFile.split("/").slice(0, -1);
  const toParts = toFile.split("/");
  let i = 0;
  while (
    i < fromParts.length &&
    i < toParts.length - 1 &&
    fromParts[i] === toParts[i]
  ) {
    i += 1;
  }
  const ups = fromParts.length - i;
  const down = toParts.slice(i);
  const rel = [...Array(ups).fill(".."), ...down].join("/");
  return rel || toParts[toParts.length - 1]!;
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

/**
 * 原子文档写（R006-C4-G）：createWithContent → note.create；
 * replaceContent 对已打开文档走 note.save，未验证路径仍 NOT_IMPLEMENTED。
 */
export class DesktopDocumentWriteRepository implements DocumentWriteRepository {
  private readonly codec: MarkdownCodec;

  constructor(
    private readonly api: E1DesktopAPI,
    private readonly scans: DesktopVaultScanCache,
    private readonly sources: DesktopDocumentSourceCache,
    codec?: MarkdownCodec,
  ) {
    this.codec = codec ?? createMarkdownCodec();
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

    const directory = this.resolveCreateDirectory(input.parentId);
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
    const ctx = this.sources.get(input.pageId);
    if (!ctx) {
      throw notImplemented(
        "覆盖文档内容（模板/导入等未验证路径）",
        "阶段 4（仅已打开文档可经 note.save 覆盖）",
      );
    }
    const parsed = parseDocumentContent(input.contentJson);
    if (!parsed.ok) {
      throw new DomainError(
        "CORRUPTED_DOCUMENT",
        "正文 JSON 未通过白名单校验",
      );
    }
    // 复用 ContentRepository.save 语义：经 serialize + note.save。
    // 此处直接 IPC，避免循环依赖 ContentRepository。
    const metadata: PortableNoteMetadata = {
      ...ctx.metadata,
      id: ctx.stableNoteId ?? ctx.metadata.id,
      updatedAt: new Date().toISOString(),
      extra: ctx.frontmatterExtra,
    };
    const serialized = await this.codec.serialize({
      document: parsed.value,
      metadata,
      assetResolver: {
        resolveAssetPath: ({ name, kind }) =>
          `assets/${kind}-${name || "file"}`,
      },
      mode: "portable",
      lineEnding: ctx.lineEnding,
    });
    let saved;
    try {
      saved = await this.api.note.save({
        vaultId: ctx.vaultId,
        relativePath: ctx.relativePath,
        markdown: serialized.markdown,
        expectedVersionToken: ctx.versionToken,
      });
    } catch (err) {
      mapNoteWriteError(err);
    }
    this.sources.updateVersion(input.pageId, saved.versionToken);
    return {
      pageId: input.pageId,
      workspaceId: ctx.vaultId,
      contentJson: parsed.value,
      textSnapshot: input.textSnapshot,
      version: saved.versionToken,
      updatedAt: saved.source?.modifiedAt ?? Date.now(),
    };
  }

  private resolveCreateDirectory(parentId: string | null): string {
    if (!parentId) return "";
    if (parentId.startsWith("path:")) {
      return parentId.slice("path:".length);
    }
    const rel = this.scans.getRelativePathSync(parentId);
    if (!rel) return "";
    const slash = rel.lastIndexOf("/");
    return slash === -1 ? "" : rel.slice(0, slash);
  }
}
