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
export function SaveStateIndicator({
  state,
  onRetry,
}: SaveStateIndicatorProps) {
  if (state.status === "error") {
    // 乐观锁冲突（R004 阶段 7）：普通重试必然再撞版本，不显示重试按钮，
    // 处理方式由正文顶部的冲突面板提供（重新载入/另存副本/强制覆盖/复制）。
    if (state.errorKind === "conflict") {
      return (
        <span className="save-state save-state--error" role="alert">
          与其他标签页的修改冲突
        </span>
      );
    }
    // 区分本地存储空间不足与普通写入失败（R004 阶段 6）：空间不足需要
    // 用户先清理数据，单纯重试大概率仍失败，文案须明确原因。
    const message =
      state.errorKind === "quota"
        ? "本地存储空间不足，请清理回收站或删除不需要的附件后重试"
        : "保存失败";
    return (
      <span className="save-state save-state--error" role="alert">
        {message}
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
