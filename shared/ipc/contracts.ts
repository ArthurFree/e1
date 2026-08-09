/**
 * R006 阶段 1：Desktop IPC 产品契约（r006 §16）。
 * R006 阶段 2：vault.scan 落地真实形状（扁平 VaultScanEntry 列表）；
 * 新增 vault:open / vault:listRecent（US-01/02/06）。
 *
 * shared/ 为 Renderer（src/platform/desktop）与 Electron Main/Preload 共用
 * 的唯一契约来源：channel 常量、请求/响应类型、E1DesktopAPI 形状。
 * 运行时校验见 ./schemas.js；错误线格式见 ../errors.js。
 *
 * 路径安全（r006 §17）：Renderer 只传 vaultId + relativePath，绝不传任意
 * 绝对路径（asset.import 的 sourceAbsolutePath 例外——它来自 Main 侧原生
 * 文件选择器 asset.pick 的返回值，非 Renderer 自造；vault.open 的
 * absolutePath 同理——它来自 Main 侧 vault.selectDirectory 的返回值）；
 * Main 侧不信任任何入参，逐字段 schema 校验 + PathGuard（normalize/realpath）。
 *
 * 版本令牌（r006 §18）：versionToken 为不透明字符串，Desktop 编码
 * "sha256:<hash>"（Web 为 "idb:N"）；save 入参携带 expectedVersionToken
 * 做乐观锁，出参返回写入后的新令牌；不一致即 DOCUMENT_CONFLICT。
 */
import type { IpcErrorPayload } from "../errors.js";

/** IPC channel 常量：Main 注册与 Preload 调用共用，禁止散落字符串。 */
export const IPC_CHANNELS = {
  vaultSelectDirectory: "vault:selectDirectory",
  vaultOpen: "vault:open",
  vaultListRecent: "vault:listRecent",
  vaultScan: "vault:scan",
  noteRead: "note:read",
  noteCreate: "note:create",
  noteSave: "note:save",
  assetPick: "asset:pick",
  assetImport: "asset:import",
  assetResolveUrl: "asset:resolveUrl",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/* ---------------------------------- vault ---------------------------------- */

/**
 * 已选中的本地 Vault 目录。
 * vaultId 为 null：目录尚未初始化（无 .e1/vault.json）——US-01 要求首次
 * 打开不修改原文件，是否初始化由 Renderer 经用户确认后调 vault.open 决定；
 * 目录已是 Vault 时返回真实 vaultId（R006 阶段 2 起读取 .e1/vault.json）。
 */
export interface SelectedVault {
  vaultId: string | null;
  /** 目录绝对路径（Main 侧原生对话框返回，Renderer 只读展示与回传 vault.open）。 */
  absolutePath: string;
  /** 展示名（目录 basename）。 */
  displayName: string;
}

/**
 * vault.open 请求：打开（必要时初始化）一个本地 Vault。
 * absolutePath 只可能来自 vault.selectDirectory / vault.listRecent 的
 * Main 侧返回值；name 仅在该目录尚未初始化时作为 vault.json 的库名
 * （缺省取目录 basename），已是 Vault 时忽略。
 */
export interface OpenVaultRequest {
  absolutePath: string;
  name?: string;
}

/** vault.open 响应：Vault 元信息（initialized 标记本次是否新建了 vault.json）。 */
export interface OpenedVault {
  vaultId: string;
  absolutePath: string;
  /** vault.json 中的库名。 */
  name: string;
  /** 展示名（目录 basename）。 */
  displayName: string;
  /** vault.json 创建时间（ISO 字符串）。 */
  createdAt: string;
  /** true：本次调用新建了 .e1/vault.json（US-02 / 首次打开确认初始化）。 */
  initialized: boolean;
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
 * noteId 是 Frontmatter 稳定身份，relativePath 只是当前位置（r006 §6.2）；
 * 读写接口按当前位置寻址，noteId 在结果中返回供镜像/索引使用。
 */
export interface ReadNoteInput {
  vaultId: string;
  relativePath: string;
}

export interface ReadNoteResult {
  noteId: string;
  relativePath: string;
  /** Markdown 原文（含 Frontmatter）；解析走 Renderer 侧 MarkdownCodec。 */
  markdown: string;
  /** 读取时的版本令牌（"sha256:<hash>"），作为后续 save 的乐观锁起点。 */
  versionToken: string;
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
}

/* ---------------------------------- asset ---------------------------------- */

/** asset.pick 原生文件选择结果（取消返回 null）。 */
export interface PickedFile {
  /** 文件名（含扩展名）。 */
  name: string;
  /** 源文件绝对路径——仅可回传给 asset.import，Renderer 不得他用。 */
  absolutePath: string;
  sizeBytes: number;
  mimeType: string;
}

export interface ImportAssetInput {
  vaultId: string;
  /** asset.pick 返回的源文件绝对路径（Main 复制进 Vault assets/）。 */
  sourceAbsolutePath: string;
  /** 期望文件名（Main 侧做冲突递增与非法字符清理）。 */
  fileName: string;
}

export interface ImportedAsset {
  /** 附件稳定身份（阶段 5 分配，当前为文件名派生）。 */
  assetId: string;
  /** 相对 Vault 根路径（如 "assets/abc.png"），Markdown 输出用它（r006 §13.3）。 */
  relativePath: string;
  sizeBytes: number;
  mimeType: string;
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
    /** 原生目录选择；取消返回 null，选中返回目录信息（已是 Vault 时带 vaultId）。 */
    selectDirectory(): Promise<SelectedVault | null>;
    /**
     * 打开本地 Vault：未初始化目录经用户确认后初始化（创建 .e1/vault.json
     * 与 assets/），已初始化目录直接打开；成功后记入最近列表（US-06）。
     */
    open(input: OpenVaultRequest): Promise<OpenedVault>;
    /** 最近打开的 Vault 列表（lastOpenedAt 倒序，上限 10 条）。 */
    listRecent(): Promise<RecentVault[]>;
    /** 扫描 Vault 生成笔记树（vaultId 经最近列表解析根目录）。 */
    scan(vaultId: string): Promise<VaultScanResult>;
  };
  note: {
    read(input: ReadNoteInput): Promise<ReadNoteResult>;
    create(input: CreateNoteInput): Promise<CreateNoteResult>;
    save(input: SaveNoteInput): Promise<SaveNoteResult>;
  };
  asset: {
    /** 原生文件选择；取消返回 null。 */
    pick(): Promise<PickedFile | null>;
    import(input: ImportAssetInput): Promise<ImportedAsset>;
    /** 解析附件为可渲染 URL（自定义协议/安全 URL，阶段 5 实现）。 */
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
