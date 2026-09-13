/**
 * 粘贴 Markdown 转换确认框：纯文本粘贴命中 Markdown 启发式时由
 * DocumentEditor 弹出（markdownPaste 扩展经 storage 回调通知）。
 * 「按 Markdown 转换」经白名单解析为所见即所得内容插入；
 * 「保持纯文本」（含 Esc / 遮罩点击）按默认粘贴行为原样插入，不丢内容。
 */
import { Dialog } from "../ui/Dialog";

interface MarkdownPasteConfirmDialogProps {
  /** 按 Markdown 语法转换并插入。 */
  onConvert(): void;
  /** 保持纯文本插入（Esc / 遮罩点击同此语义）。 */
  onKeepPlainText(): void;
}

/** 粘贴内容疑似 Markdown 时的转换确认框。 */
export function MarkdownPasteConfirmDialog({
  onConvert,
  onKeepPlainText,
}: MarkdownPasteConfirmDialogProps) {
  return (
    <Dialog
      label="检测到 Markdown 内容"
      className="modal"
      onClose={onKeepPlainText}
    >
      <h2 className="modal__title">检测到 Markdown 内容</h2>
      <div className="modal__form">
        <p>粘贴的内容疑似 Markdown 格式，是否按 Markdown 语法转换为排版样式？</p>
        <div className="modal__actions">
          <button type="button" className="button" onClick={onKeepPlainText}>
            保持纯文本
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={onConvert}
          >
            按 Markdown 转换
          </button>
        </div>
      </div>
    </Dialog>
  );
}
