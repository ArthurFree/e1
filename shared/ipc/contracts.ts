/**
 * R006 阶段 1：Desktop IPC 产品契约（r006 §16）。
 * R006 阶段 2：vault.scan 落地真实形状（扁平 VaultScanEntry 列表）；
 * 新增 vault:listRecent（US-06）。
 * R006-C2.1（FR-01/02/05，r006-c3 §8/§9/§12）：授权边界收口——
 * vault.open(absolutePath) 删除，替换为 vault.openSelection（一次性
 * selectionToken）与 vault.openRecent（registry vaultId）；selectDirectory
 * 不再向 Renderer 返回 absolutePath；PickedFile 改持 pickToken。
 * R006-C3-A（FR-12，r006-c3 §20）：note.read 落地，ReadNoteResult 改形——
 * noteId → stableNoteId（Frontmatter id，缺失为 null，Main 不创建），
 * 新增 source{modifiedAt,sizeBytes}。
 * R007 阶段 3（DSK-01）：新增首个 Main→Renderer 单向事件通道
 * events:vaultChanges（VaultFsEvent 批次）与 events.subscribeVaultChanges。
 * R007 阶段 4（文件操作闭环）：vault.createDirectory / vault.trash /
 * vault.listTrash / vault.restore / vault.purgeTrash（.e1/trash 回收站）与
 * note.move / note.renameFile（纯文件系统 rename，Frontmatter 不动、
 * stable note id 不变）。
 * R007 阶段 5（Native Secret + Reveal）：secret.status/get/set/delete
 *（Main safeStorage 加密落 userData/secrets.json；不可用时会话内存降级，
 * 永不明文落盘）与 note.reveal / asset.reveal（PathGuard 后
 * shell.showItemInFolder，Renderer 全程不见 absolutePath）。
 * R008 Stage 1：secret.status 改 SecretStorageStatus 三模式（R8-02）。
 * R008 Stage 4：search.* 组——SQLite（node:sqlite，Main）全文索引的
 * 查询/重建/增量维护通道（索引是 derived data，R8-03）。
 * R009 Stage 6（Auto Update）：update.* 组与 events:updateStatus——
 * electron-updater（GitHub Releases feed）的检查/下载/安装与状态推送；
 * macOS 未签名期间 canAutoInstall=false 降级为手动下载（R013 签名后翻 true）。
 *
 * shared/ 为 Renderer（src/platform/desktop）与 Electron Main/Preload 共用
 * 的唯一契约来源：channel 常量、请求/响应类型、E1DesktopAPI 形状。
 * 运行时校验见 ./schemas.js；错误线格式见 ../errors.js。
 *
 * 路径安全（r006 §17 / r006-c3 SEC-01）：Renderer 只传 vaultId + relativePath
 * 或 Main 签发的一次性令牌（selectionToken / pickToken），绝不传任意绝对
 * 路径——所有本地能力必须来源于用户显式选择（原生对话框）或 Main 已登记的
 * vaultId；Main 侧不信任任何入参，逐字段 schema 校验 + PathGuard。
 *
 * 版本令牌（r006 §18）：versionToken 为不透明字符串，Desktop 编码
 * "sha256:<hash>"（Web 为 "idb:N"）；save 入参携带 expectedVersionToken
 * 做乐观锁，出参返回写入后的新令牌；不一致即 DOCUMENT_CONFLICT。
 */
import type { IpcErrorPayload } from "../errors.js";

/** IPC channel 常量：Main 注册与 Preload 调用共用，禁止散落字符串。 */
export const IPC_CHANNELS = {
  vaultSelectDirectory: "vault:selectDirectory",
  vaultOpenSelection: "vault:openSelection",
  vaultOpenRecent: "vault:openRecent",
  vaultListRecent: "vault:listRecent",
  vaultScan: "vault:scan",
  vaultStateGet: "vaultState:get",
  vaultStatePatch: "vaultState:patch",
  noteRead: "note:read",
  noteCreate: "note:create",
  noteSave: "note:save",
  notePatchMetadata: "note:patchMetadata",
  noteMove: "note:move",
  noteRenameFile: "note:renameFile",
  noteReveal: "note:reveal",
  secretStatus: "secret:status",
  secretGet: "secret:get",
  secretSet: "secret:set",
  secretDelete: "secret:delete",
  vaultCreateDirectory: "vault:createDirectory",
  vaultTrash: "vault:trash",
  vaultListTrash: "vault:listTrash",
  vaultRestore: "vault:restore",
  vaultPurgeTrash: "vault:purgeTrash",
  assetPick: "asset:pick",
  assetImport: "asset:import",
  assetRead: "asset:read",
  assetResolveUrl: "asset:resolveUrl",
  assetReveal: "asset:reveal",
  searchQuery: "search:query",
  searchRebuild: "search:rebuild",
  searchUpsert: "search:upsert",
  searchRemove: "search:remove",
  searchRelocate: "search:relocate",
  searchStatus: "search:status",
  updateGetState: "update:getState",
  updateCheck: "update:check",
  updateDownload: "update:download",
  updateInstall: "update:install",
  updateOpenReleasePage: "update:openReleasePage",
  eventsVaultChanges: "events:vaultChanges",
  eventsUpdateStatus: "events:updateStatus",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/* ---------------------------------- vault ---------------------------------- */

/**
 * 已选中的本地 Vault 目录（R006-C2.1 FR-01）。
 *
 * Renderer 不再拿到 absolutePath：后续授权只凭 selectionToken（Main 签发的
 * 一次性令牌，单次消费、5 分钟过期、进程退出失效）或已登记的 vaultId。
 *
 * vaultId 为 null：目录尚未初始化（无 .e1/vault.json）——US-01/FR-03 要求
 * 首次打开不修改原文件，是否初始化由 Renderer 弹确认框后调
 * vault.openSelection 决定；initialized 与 (vaultId !== null) 同义，
 * 显式携带便于 Renderer 分流，不必做空值判断。
 */
export interface SelectedVault {
  /** 一次性目录选择授权令牌（vault.openSelection 的唯一凭证）。 */
  selectionToken: string;
  vaultId: string | null;
  /** 展示名（目录 basename）。 */
  displayName: string;
  /** true：目录已含合法 .e1/vault.json。 */
  initialized: boolean;
}

/**
 * vault.openSelection 请求（R006-C2.1 FR-01）：消费目录选择令牌。
 * initialize=false 且目录未初始化：登记 transient（仅预览）会话；
 * initialize=true 且目录未初始化：才创建 .e1/vault.json 与 assets/（FR-03）。
 */
export interface OpenSelectionRequest {
  selectionToken: string;
  initialize: boolean;
}

/**
 * vault.openRecent 请求（R006-C2.1 FR-02）：按已登记 vaultId 重新打开。
 * absolutePath 由 Main 侧注册表解析，Renderer 全程不参与路径。
 */
export interface OpenRecentRequest {
  vaultId: string;
}

/**
 * vault.openSelection / vault.openRecent 响应：Vault 元信息。
 * initialized 标记本次调用是否新建了 vault.json；transient=true 表示
 * 「仅预览」会话（vaultId 形如 transient:<uuid>，不进最近列表，重启消失）。
 *
 * absolutePath 仅作展示/诊断信息返回——已授权后告知路径可行，但 Renderer
 * 不得把它当作后续调用的授权凭证（没有任何 IPC 接口接受 absolutePath）。
 */
export interface OpenedVault {
  vaultId: string;
  absolutePath: string;
  /** vault.json 中的库名；transient 会话为目录 basename。 */
  name: string;
  /** 展示名（目录 basename）。 */
  displayName: string;
  /** vault.json 创建时间（ISO 字符串）；transient 会话为打开时刻。 */
  createdAt: string;
  /** true：本次调用新建了 .e1/vault.json（FR-03「初始化并打开」）。 */
  initialized: boolean;
  /** true：仅预览会话（FR-10/§36.1「仅预览」）；缺省/false 为常规 Vault。 */
  transient?: boolean;
}

/** 最近打开的 Vault（userData/recent-vaults.json，r006 US-06）。 */
export interface RecentVault {
  vaultId: string;
  absolutePath: string;
  displayName: string;
  /** 最近打开时间（ISO 字符串），listRecent 按其倒序。 */
  lastOpenedAt: string;
  /** 目录当前是否可访问；false 时由 UI 提示「已移动或不可访问」（重新定位属阶段 6）。 */
  accessible: boolean;
}

/** vault.scan 请求：payload 即 vaultId 字符串。 */
export type VaultScanRequest = string;

/**
 * 扫描出的单条树条目（R006 阶段 2 真实形状）。
 *
 * 采用扁平列表 + parentPath（而非嵌套树）：Renderer 阶段 3 需把条目映射为
 * Page[]（含 parentId），扁平结构按 relativePath 建索引即可一次成型，
 * 无需先遍历嵌套树再拍平。
 */
export interface VaultScanEntry {
  /**
   * 笔记稳定身份：document 取 Markdown Frontmatter id，缺失为 null
   * （r006 §6.2 身份回写属阶段 3+；本批扫描不修改任何文件）；
   * group 恒为 null——分组无 Frontmatter，以 relativePath 为身份。
   */
  noteId: string | null;
  /** 相对 Vault 根的 POSIX 风格路径（如 "学习" / "学习/React.md"）。 */
  relativePath: string;
  /** 文件夹 → group（r006 §7）；.md 文件 → document。 */
  kind: "group" | "document";
  /** 标题：document 取 Frontmatter title，缺省为文件名去 .md；group 为目录名。 */
  title: string;
  /** 父目录相对路径；位于 Vault 根为 null。 */
  parentPath: string | null;
  /** Frontmatter tags（document；group 恒为空数组）。 */
  tags: string[];
}

export interface VaultScanResult {
  vault: {
    /** .e1/vault.json 的 vaultId；目录未初始化（纯 Markdown 文件夹）为 null。 */
    vaultId: string | null;
    /** 库名：vault.json name，未初始化时为目录 basename。 */
    name: string;
    /**
     * R006-C5：受管资源目录名（来自 vault.json）；未初始化为 null。
     * Hydration 只管理该目录下的相对路径。扫描实现始终填写。
     */
    assetsDirectory?: string | null;
  };
  /**
   * 全部条目（DFS 序：每目录内先 group 后 document，各按名称
   * localeCompare("zh-CN") 排序——r006 §8 文件名排序，比较器选择在此锁定）。
   */
  entries: VaultScanEntry[];
}

/* ------------------------- 阶段 4：文件操作（vault 组） ------------------------- */

/**
 * R007 阶段 4（§4.1）：新建分组 = 真实目录。
 * name 为单段目录名（Main 侧 assertSafeFileName 复核）；根级保留名
 * （.e1 / 受管 assetsDirectory，大小写不敏感）拒绝（VAULT_RESERVED_PATH）。
 * 与既有目录同名时确定性递增改名（"name (2)"），与 note.create 同口径。
 */
export interface CreateDirectoryInput {
  vaultId: string;
  /** 父目录相对路径；空串为 Vault 根。 */
  parentRelativePath: string;
  /** 新目录名（单段，不含路径分隔符）。 */
  name: string;
}

export interface CreateDirectoryResult {
  /** 实际创建的目录相对路径（冲突已确定性递增）。 */
  relativePath: string;
}

/**
 * R007 阶段 4（§4.2）：移入回收站——rename 进 .e1/trash/<operationId>/，
 * 绝不直接 unlink；文件与目录（分组）均支持。
 */
export interface TrashInput {
  vaultId: string;
  relativePath: string;
}

export interface TrashResult {
  /** 回收站操作 id（restore/purgeTrash 的定位键）。 */
  operationId: string;
}

/** vault.listTrash 请求：payload 即 { vaultId }。 */
export interface ListTrashInput {
  vaultId: string;
}

/** 回收站条目（meta.json 的契约投影；deletedAt 倒序返回）。 */
export interface TrashEntry {
  operationId: string;
  /** 删除前的原相对路径（POSIX 风格）。 */
  originalRelativePath: string;
  /** 删除时间（ISO 字符串）。 */
  deletedAt: string;
  /** 文件为 .md 且 Frontmatter 含 id 时携带；目录/无 id 文档缺省。 */
  stableNoteId?: string;
}

export interface TrashListResult {
  entries: TrashEntry[];
}

/**
 * R007 阶段 4（§4.2）：从回收站恢复到原路径；原父目录缺失时递归重建；
 * 原路径已被占用时确定性改名恢复（"name (2).ext" 递增），返回实际路径。
 */
export interface RestoreTrashInput {
  vaultId: string;
  operationId: string;
}

export interface RestoreTrashResult {
  /** 实际恢复到的相对路径（可能因冲突被确定性改名）。 */
  relativePath: string;
}

/** 永久删除：缺省 operationId 时清空整个回收站；返回物理删除的条目数。 */
export interface PurgeTrashInput {
  vaultId: string;
  operationId?: string;
}

export interface PurgeTrashResult {
  purged: number;
}

/* -------------------------------- vaultState -------------------------------- */

/**
 * R007 阶段 2（DSK-04）：设备级交互状态——收藏/最近打开不进 Markdown
 * Frontmatter（不属于用户内容、不参与 portable truth），持久化在 Main 的
 * userData/vault-state/<vaultId>.json（Vault 复制到他机不携带）。
 *
 * 页面状态键：stableNoteId（Frontmatter id）；无 id 文档为
 * "path:<relativePath>"（与会话页面 id 派生规则一致）。Stable ID
 * Adoption 后新写走 stableNoteId 键，Renderer 读取时以 path 键兜底，
 * 并在下一次写入时清空旧 path 键（迁移，见 DesktopVaultStateClient）。
 */
export interface VaultPageState {
  favoriteAt: number | null;
  lastOpenedAt: number | null;
}

export interface VaultState {
  version: 1;
  pages: Record<string, VaultPageState>;
  workspace: { favoriteAt: number | null };
}

/**
 * 局部合并语义：缺省键保持原值；显式 null 清空该字段。
 * pages 的键缺省时不新建条目（字段全缺省的条目被忽略）。
 */
export interface VaultPageStatePatch {
  favoriteAt?: number | null;
  lastOpenedAt?: number | null;
}

export interface VaultStatePatch {
  pages?: Record<string, VaultPageStatePatch>;
  workspace?: { favoriteAt?: number | null };
}

/** vaultState.get 请求：payload 即 vaultId 字符串。 */
export type VaultStateGetRequest = string;

/** 空状态：文件缺失/损坏自愈/transient 会话的统一回退。 */
export function createEmptyVaultState(): VaultState {
  return { version: 1, pages: {}, workspace: { favoriteAt: null } };
}

export interface PatchVaultStateInput {
  vaultId: string;
  patch: VaultStatePatch;
}

/* ---------------------------------- note ---------------------------------- */

/**
 * 笔记定位形状：vaultId + relativePath（r006 §17）。
 * stableNoteId 是 Frontmatter 稳定身份，relativePath 只是当前位置（r006 §6.2）；
 * 读写接口按当前位置寻址，stableNoteId 在结果中返回供镜像/索引使用
 * （缺失为 null——无 id 文档以 path:<relativePath> 作会话身份，PR-03）。
 */
export interface ReadNoteInput {
  vaultId: string;
  relativePath: string;
}

export interface ReadNoteResult {
  /**
   * R006-C3（FR-12/§20.3）：Frontmatter 稳定 id；缺失为 null——Main 只解析
   * 不创建（PR-03：无 id 文档以 path:<relativePath> 作会话身份，首次保存
   * 回写 id 属 C4）。原 noteId: string 字段由本字段替代。
   */
  stableNoteId: string | null;
  relativePath: string;
  /** Markdown 原文（含 Frontmatter）；解析走 Renderer 侧 MarkdownCodec。 */
  markdown: string;
  /** 读取时的版本令牌（"sha256:<hash>"），作为后续 save 的乐观锁起点。 */
  versionToken: string;
  /** 磁盘来源信息（mtime/大小），供打开模型与冲突诊断使用。 */
  source: {
    /** 文件最后修改时间（ms 整数，取自 stat.mtimeMs）。 */
    modifiedAt: number;
    sizeBytes: number;
  };
  /** R006-C4：磁盘是否含 UTF-8 BOM（保存时跟随；可选以兼容旧 mock）。 */
  hadUtf8Bom?: boolean;
}

export interface CreateNoteInput {
  vaultId: string;
  /** 目标目录（相对 Vault 根，空串为根目录）。 */
  directory: string;
  /** 初始标题（写入 Frontmatter title 与文件名「无标题 (n).md」冲突递增）。 */
  title: string;
  /** 初始 Markdown 正文；缺省为带 Frontmatter 的空文档。 */
  markdown?: string;
}

export interface CreateNoteResult {
  noteId: string;
  /** 实际创建的 relativePath（文件名冲突已确定性递增）。 */
  relativePath: string;
  versionToken: string;
  /** R006-C4 FR-52：创建后磁盘来源信息。 */
  source?: {
    modifiedAt: number;
    sizeBytes: number;
  };
}

export interface SaveNoteInput {
  vaultId: string;
  relativePath: string;
  /** MarkdownCodec.serialize 产物（含 Frontmatter）。 */
  markdown: string;
  /** 乐观锁：read/create/上一次 save 返回的令牌；不一致即 DOCUMENT_CONFLICT。 */
  expectedVersionToken: string;
}

export interface SaveNoteResult {
  /** 写入后的新令牌（r006 §18：temp file → fsync → atomic rename → 新 hash）。 */
  versionToken: string;
  /** R006-C4 FR-13：写后磁盘来源信息。 */
  source: {
    modifiedAt: number;
    sizeBytes: number;
  };
}

/**
 * R007 阶段 1（DSK-03）：Frontmatter 元数据局部写入——只改 title/tags
 * 已知键，保留 id/created/aliases/未知字段与正文逐字节不变；
 * 乐观锁与正文保存同口径（expectedVersionToken 不一致即 DOCUMENT_CONFLICT）。
 */
export interface PatchNoteMetadataInput {
  vaultId: string;
  relativePath: string;
  /** 乐观锁：read/create/上一次写返回的令牌。 */
  expectedVersionToken: string;
  /** 待写字段；缺省键保持原值。两个键都缺省属于调用方错误（schema 拒绝）。 */
  patch: {
    title?: string;
    tags?: string[];
  };
}

export interface PatchNoteMetadataResult {
  /** 写入后的新令牌（供 DocumentVersionChannel 推进打开文档的乐观锁起点）。 */
  versionToken: string;
  /** 写后磁盘 mtime（ms 整数）。 */
  updatedAt: number;
  /** Frontmatter 稳定 id（无 id 文档为 null——元数据写入不做身份采纳）。 */
  stableNoteId: string | null;
}

/**
 * R007 阶段 4（§4.3）：移动文档到目标目录——纯文件系统 rename，
 * Frontmatter 逐字节不动，stable note id 不变。第一版只支持
 * document → directory（源必须是 .md 文件）；目标路径冲突报错
 * （VAULT_PATH_COLLISION，由 UI 决定是否提示改名），不做自动改名。
 */
export interface MoveNoteInput {
  vaultId: string;
  relativePath: string;
  /** 目标目录相对路径；空串为 Vault 根。 */
  targetDirectory: string;
}

export interface MoveNoteResult {
  /** 移动后的新相对路径。 */
  relativePath: string;
}

/**
 * R007 阶段 4（§4.4「重命名文件」）：物理文件名 rename（目录不变、
 * 扩展名必须为 .md），与 Title rename（note.patchMetadata）是两个独立
 * 概念。同名冲突报错（VAULT_PATH_COLLISION）。
 */
export interface RenameNoteFileInput {
  vaultId: string;
  relativePath: string;
  /** 新文件名（单段，必须 .md 结尾）。 */
  newName: string;
}

export interface RenameNoteFileResult {
  /** 重命名后的新相对路径。 */
  relativePath: string;
}

/**
 * R007 阶段 5（§5.2）：在系统文件管理器中显示笔记/分组——
 * Main 侧 resolveVaultRoot + PathGuard 后 shell.showItemInFolder；
 * relativePath 可为 .md 文件或目录（分组），目标不存在报
 * REVEAL_TARGET_NOT_FOUND。Renderer 全程不见 absolutePath。
 * 只读操作：transient 仅预览会话同样允许。
 */
export interface RevealNoteInput {
  vaultId: string;
  relativePath: string;
}

/* ---------------------------------- secret ---------------------------------- */

/**
 * R008 Stage 1（§8.6，R8-02）：机密存储运行状态——与能力字段分离：
 * capabilities.nativeSecrets 表示「Runtime 接入了系统安全存储集成」，
 * 本结构的 mode 表示「这台机器当前实际的安全后端状态」。
 *
 * - secure-persistent：安全后端可用（macOS Keychain / Windows DPAPI /
 *   Linux gnome-libsecret/kwallet），机密安全持久化；
 * - session-only：只能使用不安全后端（Linux basic_text/unknown），
 *   机密仅存本次会话（内存降级，绝不弱保护落盘）；
 * - unavailable：安全存储完全不可用（评估即失败），同样只允许会话内存。
 */
export type SecretStorageMode =
  "secure-persistent" | "session-only" | "unavailable";

export interface SecretStorageStatus {
  mode: SecretStorageMode;
  /** 后端标识（如 keychain/dpapi/kwallet6/basic_text；仅诊断展示用）。 */
  backend?: string;
  /** 降级原因（中文，供 UI 提示；不含机密内容）。 */
  reason?: string;
}

/** secret.get / secret.delete 请求：payload 即 secret 名字符串（"<域>.<键>"）。 */
export type SecretNameRequest = string;

export interface SecretSetInput {
  name: string;
  value: string;
}

/* ---------------------------------- search ---------------------------------- */

/**
 * 搜索索引状态机（R008 Stage 3 §13.1 的 wire 形态；application 层经
 * src/application/search/SearchIndexStatus.ts 重导出同一类型）：
 * missing 无索引 / building 重建中 / ready 可用 / degraded 增量失败 /
 * corrupt 库损坏（派生索引优先 rebuild，R8-03）。
 */
export type SearchIndexStatus =
  | { state: "missing" }
  | { state: "building"; progress?: number }
  | { state: "ready"; indexedDocuments: number }
  | { state: "degraded"; reason: string }
  | { state: "corrupt"; reason: string };

/** search.query 请求（R008 Stage 4 §10.5）。 */
export interface SearchQueryInput {
  /** 缺省表示跨全部已索引 Vault。 */
  vaultId?: string;
  query: string;
  /** 缺省 50，上限 100。 */
  limit?: number;
}

/** 命中字段（title > tag > body 优先级）。 */
export type SearchMatchField =
  import("../search/textMatch.js").SearchMatchField;
export {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  SEARCH_SCORE,
} from "../search/textMatch.js";

/**
 * search.query 结果行（§10.4 的 wire 形态）：pageId 为 Main 侧稳定键
 *（stableNoteId ?? path:<relativePath>），Renderer 适配层负责翻译为
 * 会话页面 id（Adoption 别名解析）。
 */
export interface SearchQueryRow {
  pageId: string;
  title: string;
  matchedField: SearchMatchField;
  /** body 命中的纯文本 snippet（无 HTML）；title/tag 命中为 null。 */
  snippet: string | null;
  score: number;
  relativePath: string;
  stableNoteId: string | null;
}

/** search.rebuild 请求：Main 全量重扫 Vault 并重建该库索引。 */
export interface SearchRebuildInput {
  vaultId: string;
}

export interface SearchRebuildResult {
  indexedDocuments: number;
}

/** search.upsert 请求：指定笔记已变化，Main 读盘解析后 upsert。 */
export interface SearchUpsertInput {
  vaultId: string;
  relativePath: string;
}

export interface SearchUpsertResult {
  /** false：文件已不存在（调用方按 deleted 处理）。 */
  indexed: boolean;
}

/** search.remove 请求：按路径或稳定键删除索引行（二选一；幂等）。
 *  文件已消失且仅有身份（stable note id）时走 noteKey。 */
export interface SearchRemoveInput {
  vaultId: string;
  relativePath?: string;
  /** R008 Stage 5：deleted 事件的稳定键（note_key 直删）。 */
  noteKey?: string;
}

/** search.relocate 请求：移动/重命名——保持身份，只改路径。 */
export interface SearchRelocateInput {
  vaultId: string;
  from: string;
  to: string;
}

/** search.status 请求：payload 即 { vaultId }。 */
export interface SearchStatusInput {
  vaultId: string;
}

/* ---------------------------------- asset ---------------------------------- */

export interface AssetPickRequest {
  /** 可接受的 MIME 列表；缺省不限。 */
  accept?: string[];
}

/**
 * asset.pick 原生文件选择结果（取消返回 null）。
 * R006-C2.1（FR-05）：absolutePath 替换为 pickToken——源路径授权同样
 * 收归 Main（一次性令牌），Renderer 不拥有来源路径。
 */
export interface PickedFile {
  /** 一次性文件选择授权令牌（asset.import 的唯一凭证）。 */
  pickToken: string;
  /** 文件名（含扩展名）。 */
  name: string;
  sizeBytes: number;
  mimeType: string;
}

export type ImportAssetSource =
  { kind: "pick-token"; token: string } | { kind: "bytes"; data: Uint8Array };

export interface ImportAssetInput {
  vaultId: string;
  fileName: string;
  mimeType: string;
  source: ImportAssetSource;
}

export interface ImportedAsset {
  assetId: string;
  /** 相对 Vault 根路径（如 "assets/abc.png"），Markdown 输出用它。 */
  relativePath: string;
  sizeBytes: number;
  mimeType: string;
}

export interface ReadAssetInput {
  assetId: string;
}

/**
 * R007 阶段 5（§5.2）：在系统文件管理器中显示附件——assetId 解码出
 * vaultId + relativePath 后与 note.reveal 同管线（PathGuard →
 * shell.showItemInFolder）；目标不存在报 REVEAL_TARGET_NOT_FOUND。
 */
export interface RevealAssetInput {
  assetId: string;
}

export interface AssetReadResult {
  assetId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  data: Uint8Array;
}

/* ---------------------------------- update ---------------------------------- */

/**
 * R009 Stage 6（Auto Update）：更新状态机。
 *
 * - idle：尚未检查；checking：检查中；
 * - available：有新版本（latestVersion 必填）；not-available：已是最新；
 * - downloading：下载中（progressPercent 0–100）；downloaded：已下载待安装；
 * - error：检查/下载失败（errorMessage 必填；更新失败不影响现有安装，
 *   DIST-07）；unsupported：非打包环境（dev / E2E 直起源码）不支持更新。
 */
export type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error"
  | "unsupported";

export interface UpdateStatus {
  state: UpdateState;
  /** 当前运行版本（package.json version）。 */
  currentVersion: string;
  /** available/downloading/downloaded 时携带的目标版本。 */
  latestVersion?: string;
  /** downloading 时的进度（0–100）。 */
  progressPercent?: number;
  /**
   * 是否支持自动下载安装：macOS 未签名期间为 false（Squirrel.Mac 拒绝替换
   * 未签名应用），UI 降级为「前往下载」手动链路；R013 签名落地后 darwin
   * 翻 true。win32（NSIS 未签名亦可）为 true，属恢复 Windows 时的未来能力
   *（MAC-01 下不在验证范围）。
   */
  canAutoInstall: boolean;
  /** 手动下载入口（GitHub Releases 页）。 */
  releasePageUrl: string;
  /** state=error 时的可读错误（不含敏感信息）。 */
  errorMessage?: string;
}

/* ---------------------------------- events ---------------------------------- */

/**
 * R007 阶段 3（DSK-01/DSK-02）：Main→Renderer 单向文件系统事件。
 *
 * Watcher 只产生事实（哪个相对路径发生了什么），不携带 absolutePath、
 * 不携带文件内容；如何 reconciliation（重扫/diff/冲突）由 Renderer 决定。
 * 事件在 Main 侧经 coalescing 去重后按批次推送（payload 为数组）。
 *
 * - note-created / note-changed / note-removed：*.md 笔记文件；
 * - asset-changed：受管 assets/ 下资源新增/修改/删除（不区分细类，
 *   消费方按需重新解析）；
 * - rescan-required：.e1/vault.json 变化或事件量异常等无法精确归因时，
 *   要求 Renderer 全量重扫。
 */
export type VaultFsEvent =
  | { type: "note-created"; vaultId: string; relativePath: string }
  | { type: "note-changed"; vaultId: string; relativePath: string }
  | { type: "note-removed"; vaultId: string; relativePath: string }
  | { type: "asset-changed"; vaultId: string; relativePath: string }
  | { type: "rescan-required"; vaultId: string };

/* --------------------------------- 桥接 API --------------------------------- */

/**
 * Preload 经 contextBridge 暴露的桌面桥（window.e1）。
 * Renderer 一律经 src/platform/desktop/desktopApi.ts 的 getDesktopApi()
 * 获取，不得直接访问 window.e1（架构门禁强制）。
 */
export interface E1DesktopAPI {
  readonly platform: "desktop";
  readonly versions: {
    electron?: string;
    chrome?: string;
    node?: string;
  };
  vault: {
    /**
     * 原生目录选择；取消返回 null，选中返回目录信息 + 一次性
     * selectionToken（不再返回 absolutePath，R006-C2.1 FR-01）。
     */
    selectDirectory(): Promise<SelectedVault | null>;
    /**
     * 消费目录选择令牌打开 Vault（R006-C2.1 FR-01）：已初始化目录直接打开
     * 并登记最近列表；未初始化目录按 initialize 分流——false 建立 transient
     * 仅预览会话（FR-03/§36.1），true 才初始化（创建 .e1/vault.json 与
     * assets/）并登记最近列表。
     */
    openSelection(input: OpenSelectionRequest): Promise<OpenedVault>;
    /**
     * 按已登记 vaultId 重新打开（R006-C2.1 FR-02）：absolutePath 由 Main
     * 注册表解析；未登记或目录不可达 → VAULT_NOT_FOUND。
     */
    openRecent(input: OpenRecentRequest): Promise<OpenedVault>;
    /** 最近打开的 Vault 列表（lastOpenedAt 倒序，上限 10 条）。 */
    listRecent(): Promise<RecentVault[]>;
    /**
     * 扫描 Vault 生成笔记树；vaultId 双通道解析——注册表（常规 Vault）或
     * transient 仅预览会话（R006-C2.1）。
     */
    scan(vaultId: string): Promise<VaultScanResult>;
    /**
     * R007 阶段 4（§4.1）：新建分组目录；同名确定性递增，
     * 保留名拒绝（VAULT_RESERVED_PATH）。transient 拒写（VAULT_READ_ONLY）。
     */
    createDirectory(
      input: CreateDirectoryInput,
    ): Promise<CreateDirectoryResult>;
    /**
     * R007 阶段 4（§4.2）：移入回收站（rename 进 .e1/trash，非 unlink）；
     * 文件与目录均支持。transient 拒写。
     */
    trash(input: TrashInput): Promise<TrashResult>;
    /** R007 阶段 4：回收站条目列表（deletedAt 倒序）；只读，transient 返回空表。 */
    listTrash(input: ListTrashInput): Promise<TrashListResult>;
    /**
     * R007 阶段 4：恢复到原路径（父目录缺失递归重建；冲突确定性改名，
     * 返回实际路径）。transient 拒写。
     */
    restore(input: RestoreTrashInput): Promise<RestoreTrashResult>;
    /** R007 阶段 4：永久删除——单个 operationId 或缺省清空整个回收站。transient 拒写。 */
    purgeTrash(input: PurgeTrashInput): Promise<PurgeTrashResult>;
  };
  /**
   * R007 阶段 2：设备级交互状态（收藏/最近打开），存 userData/vault-state/，
   * 不写 Markdown。transient 仅预览会话不落盘（get 返回空表、patch no-op）。
   */
  vaultState: {
    get(vaultId: string): Promise<VaultState>;
    /** 局部合并；返回合并后的完整状态。 */
    patch(input: PatchVaultStateInput): Promise<VaultState>;
  };
  note: {
    read(input: ReadNoteInput): Promise<ReadNoteResult>;
    create(input: CreateNoteInput): Promise<CreateNoteResult>;
    save(input: SaveNoteInput): Promise<SaveNoteResult>;
    /** R007 阶段 1：Frontmatter title/tags 局部写入（乐观锁同 note.save）。 */
    patchMetadata(
      input: PatchNoteMetadataInput,
    ): Promise<PatchNoteMetadataResult>;
    /**
     * R007 阶段 4（§4.3）：移动文档到目标目录（纯 rename，stable id 不变）；
     * 冲突报 VAULT_PATH_COLLISION。transient 拒写。
     */
    move(input: MoveNoteInput): Promise<MoveNoteResult>;
    /**
     * R007 阶段 4（§4.4「重命名文件」）：物理文件名 rename（必须 .md 结尾）；
     * 冲突报 VAULT_PATH_COLLISION。transient 拒写。
     */
    renameFile(input: RenameNoteFileInput): Promise<RenameNoteFileResult>;
    /**
     * R007 阶段 5（§5.2）：在系统文件管理器中显示笔记/分组（只读，
     * transient 允许）；目标不存在报 REVEAL_TARGET_NOT_FOUND。
     */
    reveal(input: RevealNoteInput): Promise<void>;
  };
  /**
   * R007 阶段 5（§5.1，G3）：机密存储（AI API Key）。Main 用 safeStorage
   * 加密后落 userData/secrets.json；系统安全存储不可用时降级为会话内存
   *（status().available=false），永不明文落盘。Renderer 只经本组访问，
   * 不新增 UI 专属 API（与 SecretStore port 一一对应 + status）。
   */
  secret: {
    /**
     * 机密存储运行状态（R008 §8.6）：secure-persistent 才安全持久化；
     * session-only / unavailable 时本组读写为会话内存（重启丢失）。
     */
    status(): Promise<SecretStorageStatus>;
    /** 读取 secret；不存在（或无法解密）返回 null。 */
    get(name: SecretNameRequest): Promise<string | null>;
    /** 写入（覆盖）secret。 */
    set(input: SecretSetInput): Promise<void>;
    /** 删除 secret；对缺失记录为 no-op。 */
    remove(name: SecretNameRequest): Promise<void>;
  };
  /**
   * R008 Stage 4（R8-03/04）：全文搜索索引——SQLite 派生索引的
   * 查询/重建/增量维护。结果行 pageId 为 Main 稳定键，会话身份翻译
   * 在 Renderer 适配层（DesktopSearchIndex）。
   */
  search: {
    query(input: SearchQueryInput): Promise<SearchQueryRow[]>;
    /** 全量重扫 Vault 重建索引（幂等；期间 status=building）。 */
    rebuild(input: SearchRebuildInput): Promise<SearchRebuildResult>;
    /** 指定笔记已变化：Main 读盘解析 upsert；文件已消失返回 indexed=false。 */
    upsert(input: SearchUpsertInput): Promise<SearchUpsertResult>;
    /** 按路径删除索引行（幂等）。 */
    remove(input: SearchRemoveInput): Promise<void>;
    /** 移动/重命名：保持身份只改路径。 */
    relocate(input: SearchRelocateInput): Promise<void>;
    status(input: SearchStatusInput): Promise<SearchIndexStatus>;
  };
  asset: {
    /** 原生文件选择；取消返回 null。不得返回绝对路径。 */
    pick(input?: AssetPickRequest): Promise<PickedFile | null>;
    import(input: ImportAssetInput): Promise<ImportedAsset>;
    read(input: ReadAssetInput): Promise<AssetReadResult>;
    /** 解析为 e1-asset:// URL（不含字节）。 */
    resolveUrl(assetId: string): Promise<string>;
    /**
     * R007 阶段 5（§5.2）：在系统文件管理器中显示附件（只读）；
     * 目标不存在报 REVEAL_TARGET_NOT_FOUND。
     */
    reveal(input: RevealAssetInput): Promise<void>;
  };
  /**
   * R009 Stage 6（Auto Update）：应用更新。electron-updater +
   * GitHub Releases feed（仅 stable 通道）。dev/未打包环境 state=unsupported。
   * 状态变化同时经 events.subscribeUpdateStatus 推送。
   */
  update: {
    /** 当前更新状态快照（不触发网络请求）。 */
    getState(): Promise<UpdateStatus>;
    /** 检查更新（触网）；结果即最新状态。 */
    check(): Promise<UpdateStatus>;
    /**
     * 下载已发现的更新；canAutoInstall=false（macOS 未签名降级）时为
     * no-op（返回当前状态），UI 应改走 openReleasePage。
     */
    download(): Promise<UpdateStatus>;
    /** 退出并安装已下载的更新（仅 state=downloaded 有意义）。 */
    install(): Promise<void>;
    /** 打开 GitHub Releases 页（手动下载入口，shell.openExternal）。 */
    openReleasePage(): Promise<void>;
  };
  /**
   * R007 阶段 3：Main→Renderer 单向事件订阅（唯一推送通道）。
   * 订阅 Vault 文件系统变化（Watcher 事实批次）；返回取消订阅函数。
   * Renderer 不得经其它途径拿 ipcRenderer 本体。
   */
  events: {
    subscribeVaultChanges(
      listener: (events: VaultFsEvent[]) => void,
    ): () => void;
    /** R009 Stage 6：订阅更新状态推送；返回取消订阅函数。 */
    subscribeUpdateStatus(listener: (status: UpdateStatus) => void): () => void;
  };
}

/* --------------------------------- 结果信封 --------------------------------- */

/**
 * Main → Preload 的统一结果信封：Main handler 永不 throw（Electron 对
 * ipcMain.handle 抛出的错误序列化不可靠），一律返回 IpcResult；
 * preload 层解包——ok 取值，否则拒签为 DesktopIpcError（见 errors.js）。
 */
export type IpcResult<T> =
  { ok: true; value: T } | { ok: false; error: IpcErrorPayload };
