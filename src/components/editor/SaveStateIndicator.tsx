/**
 * 保存状态指示器（R001 §8.1）：顶栏展示当前文档的保存状态。
 * 纯展示组件，状态由 DocumentEditor 的保存状态机驱动；
 * 失败时提供「重试」按钮，重试动作由父级经 onRegisterRetry 注册后传入。
 */
import type { SaveState } from "./DocumentEditor";

/** SaveStateIndicator 入参。 */
interface SaveStateIndicatorProps {
  /** 保存状态机当前状态，见 DocumentEditor 的 SaveState。 */
  state: SaveState;
  /** 「重试」按钮回调：以当前编辑器内容立即重新保存。 */
  onRetry(): void;
}

/** 把时间戳格式化为本地 HH:MM:SS（保存时刻只关心当天时分秒）。 */
function formatSavedAt(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 保存状态（R001 §8.1）：编辑后、保存中、已保存时间、失败与重试。 */
export function SaveStateIndicator({ state, onRetry }: SaveStateIndicatorProps) {
  if (state.status === "error") {
    return (
      <span className="save-state save-state--error" role="alert">
        保存失败
        <button type="button" className="save-state__retry" onClick={onRetry}>
          重试
        </button>
      </span>
    );
  }
  const text =
    state.status === "dirty"
      ? "有未保存更改"
      : state.status === "saving"
        ? "保存中…"
        : state.savedAt !== null
          ? `已保存 ${formatSavedAt(state.savedAt)}`
          : "已保存";
  return (
    <span className="save-state" role="status">
      {text}
    </span>
  );
}
