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
  noteRead: "note:read",
  noteCreate: "note:create",
  noteSave: "note:save",
  assetPick: "asset:pick",
  assetImport: "asset:import",
  assetRead: "asset:read",
  assetResolveUrl: "asset:resolveUrl",
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
  | { kind: "pick-token"; token: string }
  | { kind: "bytes"; data: Uint8Array };

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

export interface AssetReadResult {
  assetId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  data: Uint8Array;
}

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
  };
  note: {
    read(input: ReadNoteInput): Promise<ReadNoteResult>;
    create(input: CreateNoteInput): Promise<CreateNoteResult>;
    save(input: SaveNoteInput): Promise<SaveNoteResult>;
  };
  asset: {
    /** 原生文件选择；取消返回 null。不得返回绝对路径。 */
    pick(input?: AssetPickRequest): Promise<PickedFile | null>;
    import(input: ImportAssetInput): Promise<ImportedAsset>;
    read(input: ReadAssetInput): Promise<AssetReadResult>;
    /** 解析为 e1-asset:// URL（不含字节）。 */
    resolveUrl(assetId: string): Promise<string>;
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
