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
  | "DOCUMENT_CONFLICT";

/** 领域错误：code 是稳定契约，message 是中文用户文案。 */
export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
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
