/**
 * 本地版本历史策略（R001 §8.3）：
 * 自动版本距上一个至少 5 分钟；每篇文档最多保留 100 个自动版本。
 * 手动（manual）与恢复前（before-restore）版本不受间隔限制，也不在自动清理范围内；
 * 超出上限的清理由仓储层 RevisionRepository.pruneInterval 执行。
 */

/** 相邻两个自动版本的最小间隔（毫秒）。 */
export const INTERVAL_REVISION_MS = 5 * 60 * 1000;
/** 每篇文档保留的自动版本数量上限。 */
export const INTERVAL_REVISION_KEEP = 100;

/** 距上一个自动版本达到间隔时才创建新的 interval 版本。 */
export function shouldCreateIntervalRevision(
  lastIntervalAt: number | null,
  now: number,
): boolean {
  // 从未创建过自动版本时立即允许；此后按间隔节流，避免频繁保存刷出版本噪音。
  return lastIntervalAt === null || now - lastIntervalAt >= INTERVAL_REVISION_MS;
}
