/**
 * 本地版本历史策略（R001 §8.3）：
 * 自动版本距上一个至少 5 分钟；每篇文档最多保留 100 个自动版本。
 * 手动（manual）与恢复前（before-restore）版本不受间隔限制，也不在自动清理范围内；
 * 超出上限的清理由仓储层 RevisionRepository.pruneInterval 执行。
 *
 * retention 常量与确定性裁剪规则的单一实现在 shared/revisions/retention.ts
 * （electron 不得 import src，R012 Stage 1 上移），此处 re-export 保持既有调用点。
 */
export {
  INTERVAL_REVISION_KEEP,
  INTERVAL_REVISION_MAX_BYTES,
  selectRevisionsToPrune,
} from "../../shared/revisions/retention";

/** 相邻两个自动版本的最小间隔（毫秒）。 */
export const INTERVAL_REVISION_MS = 5 * 60 * 1000;

/** 距上一个自动版本达到间隔时才创建新的 interval 版本。 */
export function shouldCreateIntervalRevision(
  lastIntervalAt: number | null,
  now: number,
): boolean {
  // 从未创建过自动版本时立即允许；此后按间隔节流，避免频繁保存刷出版本噪音。
  return (
    lastIntervalAt === null || now - lastIntervalAt >= INTERVAL_REVISION_MS
  );
}

/**
 * 版本内容 JSON 序列化后的 UTF-8 字节数（近似占用）。
 * 用于版本空间预算与设置页占用估算。
 */
export function revisionContentBytes(contentJson: unknown): number {
  return new Blob([JSON.stringify(contentJson ?? null)]).size;
}
