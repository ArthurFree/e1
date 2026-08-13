/**
 * @file 正文加载错误块（R006-C3 §36.3，自 MainArea 提取，行为不变）。
 * 按 DomainError.code 分流中文标题/说明/操作按钮，绝不展示 Node 栈或
 * 英文原始 message；DOCUMENT_TOO_LARGE 额外透传实际大小与上限。
 */

import { isDomainError } from "../../domain/errors";
import { Button } from "../ui/Button";
import { IconAlertTriangle } from "../ui/icons";

/** 正文加载错误的展示模型（图标 + 标题 + 说明 + 操作按钮）。 */
interface ContentErrorView {
  title: string;
  description: string;
  /** 重试：重新执行正文加载。 */
  retry: boolean;
  /** 重新扫描知识库（FR-23）。 */
  rescan: boolean;
  /** 关闭：返回知识库首页。 */
  close: boolean;
}

/** 字节数 → 用户可读 MB 文案（DOCUMENT_TOO_LARGE 的 details 透传值）。 */
function formatMegaBytes(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 正文加载错误 → 中文错误块（R006-C3 §36.3，FR-17/23/24/25）：
 * 按 DomainError.code 分流标题/说明/按钮，绝不展示 Node 栈或英文原始 message。
 */
function describeContentError(err: unknown): ContentErrorView {
  if (isDomainError(err)) {
    switch (err.code) {
      case "PAGE_NOT_FOUND":
        // FR-23：扫描时存在、打开前已被外部程序移动/删除。
        return {
          title: "这篇笔记已经不存在",
          description: "它可能已经被其他程序移动或删除。",
          retry: false,
          rescan: true,
          close: false,
        };
      case "DOCUMENT_TOO_LARGE": {
        const size = formatMegaBytes(err.details?.sizeBytes);
        const max = formatMegaBytes(err.details?.maxBytes);
        return {
          title: "文件过大，暂无法打开",
          description:
            size && max
              ? `该 Markdown 约 ${size}，当前版本最大支持 ${max}。文件本身没有被修改。`
              : "该 Markdown 超过当前版本的大小上限，文件本身没有被修改。",
          retry: false,
          rescan: false,
          close: true,
        };
      }
      case "NOTE_PERMISSION_DENIED":
        return {
          title: "无法读取该 Markdown",
          description: "请检查当前系统用户是否具有该文件的读取权限。",
          retry: true,
          rescan: false,
          close: false,
        };
      case "NOTE_IO_ERROR":
        return {
          title: "读取 Markdown 时发生系统错误",
          description: "文件本身没有被修改。",
          retry: true,
          rescan: false,
          close: false,
        };
      case "UNSUPPORTED_ENCODING":
        return {
          title: "无法识别该文件的编码",
          description:
            "当前文件可能不是 UTF-8 编码，E1 暂时无法安全打开该 Markdown。",
          retry: true,
          rescan: false,
          close: false,
        };
      case "WORKSPACE_NOT_FOUND":
        return {
          title: "知识库目录不可访问",
          description:
            "请确认该知识库目录仍然存在，且当前系统用户具有读取权限。",
          retry: true,
          rescan: false,
          close: false,
        };
      default:
        break;
    }
  }
  return {
    title: "文档内容加载失败",
    description: "请重试；若多次失败，请重新打开该知识库。",
    retry: true,
    rescan: false,
    close: false,
  };
}

/** 文件读取错误块（R006-C3 §36.3）：图标 + 标题 + 说明 + 操作按钮。 */
export function ContentErrorBlock({
  error,
  onRetry,
  onRescan,
  onClose,
}: {
  error: unknown;
  onRetry(): void;
  /** 重新扫描（FR-26）：仅 Desktop 提供，缺省时按钮不渲染。 */
  onRescan?(): void;
  onClose(): void;
}) {
  const view = describeContentError(error);
  return (
    <div className="content-error" role="alert">
      <div className="content-error__icon" aria-hidden="true">
        <IconAlertTriangle size={20} />
      </div>
      <h2 className="content-error__title">{view.title}</h2>
      <p className="content-error__description">{view.description}</p>
      <div className="content-error__actions">
        {view.retry && (
          <Button variant="primary" onClick={onRetry}>
            重试
          </Button>
        )}
        {view.rescan && onRescan && (
          <Button variant="primary" onClick={onRescan}>
            重新扫描知识库
          </Button>
        )}
        {view.close && (
          <Button variant="secondary" onClick={onClose}>
            关闭
          </Button>
        )}
      </div>
    </div>
  );
}
