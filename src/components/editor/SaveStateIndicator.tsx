import type { SaveState } from "./DocumentEditor";

interface SaveStateIndicatorProps {
  state: SaveState;
  onRetry(): void;
}

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
