/**
 * 领域错误（R003 阶段 4）：稳定的结构化错误码，取代散落的中文字符串 Error。
 *
 * 约定：
 * - code 供程序判断（测试、错误映射、未来的同步冲突处理），是稳定契约；
 * - message 保持面向用户的中文文案，UI 不得解析 message 判断错误类型；
 * - 仓储层与领域纯函数（pageTree 等）统一抛 DomainError。
 */

/** 领域错误码。 */
export type DomainErrorCode =
  /** 知识库不存在或数据损坏。 */
  | "WORKSPACE_NOT_FOUND"
  /** 页面不存在或数据损坏（含已永久删除）。 */
  | "PAGE_NOT_FOUND"
  /** 父页面不存在。 */
  | "PARENT_NOT_FOUND"
  /** 父页面属于其他知识库。 */
  | "CROSS_WORKSPACE_PARENT"
  /** 移动会形成树环（移动到自身或后代下）。 */
  | "PAGE_TREE_CYCLE"
  /** 父页面在回收站中，不能作为正常父级。 */
  | "PARENT_IN_TRASH"
  /** 标签不存在。 */
  | "TAG_NOT_FOUND"
  /** 标签与页面属于不同知识库。 */
  | "CROSS_WORKSPACE_TAG"
  /** 入参非法（kind、标题长度、附件文件名等）。 */
  | "INVALID_INPUT"
  /** 附件超过单文件上限或所属文档附件总量上限。 */
  | "ATTACHMENT_TOO_LARGE"
  /** 附件类型不在允许范围内（如图片 MIME 白名单之外）。 */
  | "UNSUPPORTED_ATTACHMENT_TYPE"
  /** 文档正文 JSON 损坏。 */
  | "CORRUPTED_DOCUMENT"
  /** 正文乐观并发冲突：磁盘 version 与保存时的 expectedVersion 不一致。 */
  | "DOCUMENT_CONFLICT"
  /** 当前平台/阶段尚未实现的能力（R006 阶段 2：Desktop 写路径诚实失败）。 */
  | "NOT_IMPLEMENTED"
  /** 用户取消了原生选择流程（R006 阶段 2：Desktop 目录选择取消）。 */
  | "CANCELLED"
  /**
   * R006-C3（FR-24）：读取 Markdown 被系统拒绝（EACCES/EPERM）。
   * 由 Desktop 正文仓储把同名 IPC 码映射进 domain，UI 按 code 分流。
   */
  | "NOTE_PERMISSION_DENIED"
  /** R006-C3（FR-25）：读取 Markdown 的其他系统 I/O 错误（文件未被修改）。 */
  | "NOTE_IO_ERROR"
  /** R006-C4：写入 Markdown 被拒绝（EACCES/EPERM）。 */
  | "NOTE_WRITE_PERMISSION_DENIED"
  /** R006-C4：写入 Markdown 的其他系统 I/O 错误。 */
  | "NOTE_WRITE_IO_ERROR"
  /** R006-C4：仅预览（transient）Vault 拒绝任何写操作。 */
  | "VAULT_READ_ONLY"
  /**
   * R006-C3（FR-09）：Markdown 超过单文件大小上限（10 MiB）；
   * details 携带 { sizeBytes, maxBytes } 供 UI 展示。
   */
  | "DOCUMENT_TOO_LARGE"
  /** R006-C3（FR-10）：文件无法作为 UTF-8 安全解码（不猜测/不转码）。 */
  | "UNSUPPORTED_ENCODING"
  /**
   * R006-C4：Tiptap → Markdown 序列化有损，自动保存已暂停；
   * 用户显式「仍然保存」后会话内可继续。
   */
  | "MARKDOWN_LOSSY_OUTPUT"
  /**
   * R006-C4.1：Desktop 来源上下文缺失（未打开或已失效），不得猜测路径/Frontmatter。
   */
  | "DOCUMENT_SOURCE_CONTEXT_REQUIRED"
  /**
   * R006-C2.1（FR-03）：选中的文件夹尚未初始化，等待用户在确认框中选择
   * 「仅预览 / 初始化并打开 / 取消」——仅 Desktop 打开本地知识库链路使用，
   * 不跨 IPC；UI 接住后调 platform/desktop 的确认握手模块再继续。
   */
  | "VAULT_CONFIRMATION_REQUIRED";

/** 领域错误：code 是稳定契约，message 是中文用户文案。 */
export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    /**
     * R006-C3：可选结构化细节（如 DOCUMENT_TOO_LARGE 的 { sizeBytes, maxBytes }）。
     * 程序只读字段值，不得以此替代 code 判断错误类型。
     */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

/** 类型守卫：判断错误是否为 DomainError（可选指定错误码）。 */
export function isDomainError(
  err: unknown,
  code?: DomainErrorCode,
): err is DomainError {
  return (
    err instanceof DomainError && (code === undefined || err.code === code)
  );
}

/**
 * 判断错误是否为浏览器存储配额耗尽（R004 阶段 6）。
 * IndexedDB 写入在配额耗尽时抛 DOMException（name 为 QuotaExceededError，
 * 老实现为 code 22）；保存与附件写入链路据此区分「空间不足」与普通失败。
 */
export function isQuotaExceededError(error: unknown): boolean {
  if (!(error instanceof DOMException)) return false;
  return error.name === "QuotaExceededError" || error.code === 22;
}
