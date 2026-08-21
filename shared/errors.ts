/**
 * R006 阶段 1：Desktop IPC 统一错误码与线格式。
 *
 * shared/ 同时被 Electron Main/Preload（NodeNext）与 Renderer（src/，
 * bundler）编译，不得依赖 Node/DOM API，也不得 import src/（electron 不得
 * 依赖 src 的反向约束）；与 domain DomainError 的对齐采用鸭子类型映射。
 *
 * 线格式（Main → Preload → Renderer 的错误载荷）：
 *   { code: IpcErrorCode, message: string }
 * code 供程序判断，message 保持面向用户的中文文案，UI 不得解析 message
 * 判断错误类型（与 src/domain/errors.ts 同约定）。
 */

/** IPC 错误码（稳定契约）。 */
export type IpcErrorCode =
  /** Renderer 入参形状/类型非法（schema 校验失败）。 */
  | "INVALID_INPUT"
  /** 契约已冻结但对应阶段尚未实现（阶段 2+ 逐个落地）。 */
  | "NOT_IMPLEMENTED"
  /** vaultId 对应的 Vault 不存在或目录不可访问。 */
  | "VAULT_NOT_FOUND"
  /** R006-C2.1（FR-04）：读取 Vault 元数据被拒绝（EACCES/EPERM）。 */
  | "VAULT_PERMISSION_DENIED"
  /** R006-C2.1（FR-04）：读取 Vault 元数据的其他系统 I/O 错误。 */
  | "VAULT_IO_ERROR"
  /** R006-C2.1（FR-01）：目录选择授权令牌过期（5 分钟）。 */
  | "SELECTION_EXPIRED"
  /** R006-C2.1（FR-01）：目录选择授权令牌不存在/已被消费/伪造。 */
  | "SELECTION_INVALID"
  /** 指定 noteId/relativePath 的笔记不存在。 */
  | "NOTE_NOT_FOUND"
  /** R006-C3（FR-24）：读取 Markdown 被拒绝（EACCES/EPERM）。 */
  | "NOTE_PERMISSION_DENIED"
  /** R006-C3（FR-25）：读取 Markdown 的其他系统 I/O 错误。 */
  | "NOTE_IO_ERROR"
  /** R006-C4（FR-10）：写入 Markdown 被拒绝（EACCES/EPERM）。 */
  | "NOTE_WRITE_PERMISSION_DENIED"
  /** R006-C4（FR-10）：写入 Markdown 的其他系统 I/O 错误。 */
  | "NOTE_WRITE_IO_ERROR"
  /** R006-C4（FR-15）：仅预览（transient）Vault 拒绝任何写操作。 */
  | "VAULT_READ_ONLY"
  /** R006-C3（FR-09）：Markdown 超过单文件大小上限（10 MiB）。 */
  | "DOCUMENT_TOO_LARGE"
  /** R006-C3（FR-10）：文件无法作为 UTF-8 安全解码（不猜测/不转码）。 */
  | "UNSUPPORTED_ENCODING"
  /** 附件不存在。 */
  | "ASSET_NOT_FOUND"
  /** R006-C5：写入资源被拒绝（EACCES/EPERM）。 */
  | "ASSET_WRITE_PERMISSION_DENIED"
  /** R006-C5：写入资源的其他系统 I/O 错误。 */
  | "ASSET_WRITE_IO_ERROR"
  /** R006-C5：原生选择的源文件在导入前已消失。 */
  | "ASSET_SOURCE_NOT_FOUND"
  /** 路径逃逸：相对路径含 ../、绝对路径注入或符号链接逃逸出 Vault 根。 */
  | "PATH_ESCAPE"
  /** 保存乐观锁冲突：expectedVersionToken 与磁盘当前 hash 不一致。 */
  | "DOCUMENT_CONFLICT"
  /** R007 阶段 4：文件操作目标路径已存在（move/renameFile 冲突报错口径）。 */
  | "VAULT_PATH_COLLISION"
  /** R007 阶段 4：操作触及保留路径（.e1/ 或受管 assetsDirectory）。 */
  | "VAULT_RESERVED_PATH"
  /** R007 阶段 4：回收站操作不存在（operationId 未找到）。 */
  | "VAULT_TRASH_NOT_FOUND"
  /** R007 阶段 4：恢复时确定性改名仍无法分配不冲突路径（递增耗尽）。 */
  | "VAULT_RESTORE_COLLISION"
  /** R008 Stage 1（§8）：secret 存储完全不可用（无安全后端且无法读写）。 */
  | "SECRET_STORAGE_UNAVAILABLE"
  /** 未分类的 Main 侧内部错误。 */
  | "INTERNAL";

/** IPC 错误线格式：Main 侧统一归一为本形状，经 preload 拒签为 Error。 */
export interface IpcErrorPayload {
  code: IpcErrorCode;
  message: string;
  /**
   * R006-C3（FR-09）：可选结构化细节（如 DOCUMENT_TOO_LARGE 携带
   * { sizeBytes, maxBytes } 供 UI 展示文件大小/上限）；程序只读字段值，
   * 不得以此替代 code 判断错误类型。
   */
  details?: Record<string, unknown>;
}

/** IPC 调用失败：Main/Preload/Renderer 三侧共用的带码 Error。 */
export class IpcFailure extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "IpcFailure";
  }
}

/**
 * Renderer 侧收到的 IPC 错误（preload 拒签产物）。
 * 与 IpcFailure 同形状，独立类名便于 renderer try/catch 区分本地错误。
 */
export class DesktopIpcError extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DesktopIpcError";
  }
}

/** 类型守卫：判断未知值是否为 IPC 错误线格式。 */
export function isIpcErrorPayload(value: unknown): value is IpcErrorPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.code === "string" && typeof v.message === "string";
}

/**
 * contextBridge 线格式前缀：sandbox 开启时，preload 抛出的自定义 Error
 * 跨桥进入 Renderer 主世界会被重建为 plain Error，name/code 等自有属性
 * 全部丢失（Electron 43 实测），只有 message 存活。因此 preload 把错误载荷
 * 编码进 message，Renderer 侧（desktopApi）再解码还原为 DesktopIpcError。
 */
export const IPC_BRIDGE_ERROR_PREFIX = "E1_IPC_ERROR:";

/** preload 侧：把 IPC 错误载荷编码为可跨 contextBridge 存活的 Error。 */
export function encodeIpcBridgeError(payload: IpcErrorPayload): Error {
  return new Error(IPC_BRIDGE_ERROR_PREFIX + JSON.stringify(payload));
}

/** Renderer 侧：解码跨桥错误；非桥编码错误返回 null（本地错误原样抛出）。 */
export function decodeIpcBridgeError(error: unknown): IpcErrorPayload | null {
  if (!(error instanceof Error)) return null;
  if (!error.message.startsWith(IPC_BRIDGE_ERROR_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(
      error.message.slice(IPC_BRIDGE_ERROR_PREFIX.length),
    );
    return isIpcErrorPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * domain DomainError 的鸭子类型视图（shared 不得 import src/domain，
 * 此处只声明结构；真实定义见 src/domain/errors.ts）。
 */
interface DomainErrorLike {
  name: string;
  code: string;
  message: string;
}

function isDomainErrorLike(value: unknown): value is DomainErrorLike {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.name === "DomainError" &&
    typeof v.code === "string" &&
    typeof v.message === "string"
  );
}

/** domain 错误码 → IPC 错误码（阶段 2+ Main 侧文件/笔记编排抛 DomainError 时归一用）。 */
const DOMAIN_TO_IPC: Record<string, IpcErrorCode> = {
  INVALID_INPUT: "INVALID_INPUT",
  DOCUMENT_CONFLICT: "DOCUMENT_CONFLICT",
  WORKSPACE_NOT_FOUND: "VAULT_NOT_FOUND",
  PAGE_NOT_FOUND: "NOTE_NOT_FOUND",
  PARENT_NOT_FOUND: "NOTE_NOT_FOUND",
  TAG_NOT_FOUND: "INVALID_INPUT",
  CROSS_WORKSPACE_PARENT: "INVALID_INPUT",
  CROSS_WORKSPACE_TAG: "INVALID_INPUT",
  PAGE_TREE_CYCLE: "INVALID_INPUT",
  PARENT_IN_TRASH: "INVALID_INPUT",
  ATTACHMENT_TOO_LARGE: "INVALID_INPUT",
  UNSUPPORTED_ATTACHMENT_TYPE: "INVALID_INPUT",
  CORRUPTED_DOCUMENT: "INTERNAL",
  // R006 阶段 2：Desktop 写路径的诚实失败码原样透传（CANCELLED 只出现在
  // Renderer 侧原生选择流程，不跨 IPC，刻意不映射）。
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
  // R006-C3：笔记读取的四个 Main 侧原生码在 domain 中有同名对应（FR-09/10/24/25），
  // 双向原样透传。
  NOTE_PERMISSION_DENIED: "NOTE_PERMISSION_DENIED",
  NOTE_IO_ERROR: "NOTE_IO_ERROR",
  DOCUMENT_TOO_LARGE: "DOCUMENT_TOO_LARGE",
  UNSUPPORTED_ENCODING: "UNSUPPORTED_ENCODING",
  // R006-C4：写路径错误码（与 domain 同名，双向透传）。
  NOTE_WRITE_PERMISSION_DENIED: "NOTE_WRITE_PERMISSION_DENIED",
  NOTE_WRITE_IO_ERROR: "NOTE_WRITE_IO_ERROR",
  VAULT_READ_ONLY: "VAULT_READ_ONLY",
  ASSET_WRITE_PERMISSION_DENIED: "ASSET_WRITE_PERMISSION_DENIED",
  ASSET_WRITE_IO_ERROR: "ASSET_WRITE_IO_ERROR",
  ASSET_SOURCE_NOT_FOUND: "ASSET_SOURCE_NOT_FOUND",
};

/** IPC 错误码 → domain 错误码（可反向映射的子集；无对应 domain 语义时为 null）。 */
const IPC_TO_DOMAIN: Partial<Record<IpcErrorCode, string>> = {
  INVALID_INPUT: "INVALID_INPUT",
  DOCUMENT_CONFLICT: "DOCUMENT_CONFLICT",
  VAULT_NOT_FOUND: "WORKSPACE_NOT_FOUND",
  NOTE_NOT_FOUND: "PAGE_NOT_FOUND",
  // R006-C2.1：VAULT_PERMISSION_DENIED / VAULT_IO_ERROR / SELECTION_EXPIRED /
  // SELECTION_INVALID 为 Main 侧 IpcFailure 原生码，无 domain 对应语义，
  // 反向映射得 null（与 NOT_IMPLEMENTED/PATH_ESCAPE 同处理）。
  // R006-C3（FR-09/10/24/25）：笔记读取四码已加入 domain（同名），反向映射。
  NOTE_PERMISSION_DENIED: "NOTE_PERMISSION_DENIED",
  NOTE_IO_ERROR: "NOTE_IO_ERROR",
  DOCUMENT_TOO_LARGE: "DOCUMENT_TOO_LARGE",
  UNSUPPORTED_ENCODING: "UNSUPPORTED_ENCODING",
  NOTE_WRITE_PERMISSION_DENIED: "NOTE_WRITE_PERMISSION_DENIED",
  NOTE_WRITE_IO_ERROR: "NOTE_WRITE_IO_ERROR",
  VAULT_READ_ONLY: "VAULT_READ_ONLY",
  ASSET_WRITE_PERMISSION_DENIED: "ASSET_WRITE_PERMISSION_DENIED",
  ASSET_WRITE_IO_ERROR: "ASSET_WRITE_IO_ERROR",
  ASSET_SOURCE_NOT_FOUND: "ASSET_SOURCE_NOT_FOUND",
  // R007 阶段 4（§11）：文件操作新码尽量映射回既有 domain 码，不为其新增
  // DomainError code——UI 需要分流时直接读 DesktopIpcError.code（IPC 原码）。
  VAULT_PATH_COLLISION: "INVALID_INPUT",
  VAULT_RESERVED_PATH: "INVALID_INPUT",
  VAULT_TRASH_NOT_FOUND: "PAGE_NOT_FOUND",
  VAULT_RESTORE_COLLISION: "INVALID_INPUT",
  // R008 Stage 1：SECRET_STORAGE_UNAVAILABLE 为 Main 侧原生码，无 domain
  // 对应语义（不新增 DomainError code，R007 §11 同原则）——反向映射得 null，
  // UI 需要分流时直接读 DesktopIpcError.code。
};

/** DomainError → IPC 错误载荷；未识别的 domain code 归一为 INTERNAL。 */
export function ipcErrorFromDomain(error: DomainErrorLike): IpcErrorPayload {
  return {
    code: DOMAIN_TO_IPC[error.code] ?? "INTERNAL",
    message: error.message,
  };
}

/** IPC 错误码 → domain 错误码；无对应语义（NOT_IMPLEMENTED/PATH_ESCAPE 等）返回 null。 */
export function domainCodeFromIpc(code: IpcErrorCode): string | null {
  return IPC_TO_DOMAIN[code] ?? null;
}

/**
 * Main 侧统一异常归一：任意抛出物 → IPC 错误线格式。
 * IpcFailure 取自身 code；DomainError 经映射表；其余 Error/未知值为 INTERNAL。
 */
export function toIpcErrorPayload(error: unknown): IpcErrorPayload {
  if (error instanceof IpcFailure) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  // DomainError 判定先于线格式守卫：DomainError 同样带 code/message，
  // 但其 code 是 domain 码，必须经映射表转换。
  if (isDomainErrorLike(error)) {
    return ipcErrorFromDomain(error);
  }
  if (isIpcErrorPayload(error)) {
    // details 透传（仅当是普通对象；FR-09 DOCUMENT_TOO_LARGE 的 sizeBytes/maxBytes）。
    const details =
      typeof error.details === "object" && error.details !== null
        ? { details: error.details }
        : {};
    return { code: error.code, message: error.message, ...details };
  }
  if (error instanceof Error) {
    return { code: "INTERNAL", message: error.message };
  }
  return { code: "INTERNAL", message: "未知错误" };
}
