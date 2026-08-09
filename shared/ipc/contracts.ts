/**
 * R006 阶段 1：Desktop IPC 产品契约（r006 §16）。
 *
 * shared/ 为 Renderer（src/platform/desktop）与 Electron Main/Preload 共用
 * 的唯一契约来源：channel 常量、请求/响应类型、E1DesktopAPI 形状。
 * 运行时校验见 ./schemas.js；错误线格式见 ../errors.js。
 *
 * 路径安全（r006 §17）：Renderer 只传 vaultId + relativePath，绝不传任意
 * 绝对路径（asset.import 的 sourceAbsolutePath 例外——它来自 Main 侧原生
 * 文件选择器 asset.pick 的返回值，非 Renderer 自造）；Main 侧不信任任何
 * 入参，逐字段 schema 校验 + 阶段 2 的 PathGuard（normalize/realpath）。
 *
 * 版本令牌（r006 §18）：versionToken 为不透明字符串，Desktop 编码
 * "sha256:<hash>"（Web 为 "idb:N"）；save 入参携带 expectedVersionToken
 * 做乐观锁，出参返回写入后的新令牌；不一致即 DOCUMENT_CONFLICT。
 */
import type { IpcErrorPayload } from "../errors.js";

/** IPC channel 常量：Main 注册与 Preload 调用共用，禁止散落字符串。 */
export const IPC_CHANNELS = {
  vaultSelectDirectory: "vault:selectDirectory",
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
 * vaultId 为 null：selectDirectory 只完成目录选择，vaultId 待阶段 2 扫描
 * （读取/创建 .e1/vault.json）后分配。
 */
export interface SelectedVault {
  vaultId: string | null;
  /** 目录绝对路径（Main 侧原生对话框返回，Renderer 只读展示用）。 */
  absolutePath: string;
  /** 展示名（目录 basename）。 */
  displayName: string;
}

/** vault.scan 请求：payload 即 vaultId 字符串。 */
export type VaultScanRequest = string;

/** 扫描出的单条笔记条目（阶段 2 产物形状，阶段 1 仅冻结契约）。 */
export interface VaultScanEntry {
  /** 笔记稳定身份（Markdown Frontmatter id；缺失时由扫描分配并回写）。 */
  noteId: string;
  /** 相对 Vault 根的 POSIX 风格路径（如 "学习/React.md"）。 */
  relativePath: string;
  /** 标题（Frontmatter title 或文件名去扩展名）。 */
  title: string;
  /** 文件 mtime（毫秒时间戳）。 */
  updatedAt: number;
}

export interface VaultScanResult {
  vaultId: string;
  /** 文件夹相对路径列表（映射为分组），按名称排序。 */
  folders: string[];
  /** 全部 .md 笔记条目，按 relativePath 排序（r006 §8：文件名排序）。 */
  notes: VaultScanEntry[];
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
    /** 原生目录选择；取消返回 null，选中返回 vaultId 为 null 的目录信息。 */
    selectDirectory(): Promise<SelectedVault | null>;
    /** 扫描 Vault 生成笔记树（阶段 2 实现，阶段 1 返回 NOT_IMPLEMENTED）。 */
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
