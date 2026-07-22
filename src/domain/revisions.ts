/**
 * 本地版本历史策略（R001 §8.3）：
 * 自动版本距上一个至少 5 分钟；每篇文档最多保留 100 个自动版本。
 */

export const INTERVAL_REVISION_MS = 5 * 60 * 1000;
export const INTERVAL_REVISION_KEEP = 100;

/** 距上一个自动版本达到间隔时才创建新的 interval 版本。 */
export function shouldCreateIntervalRevision(
  lastIntervalAt: number | null,
  now: number,
): boolean {
  return lastIntervalAt === null || now - lastIntervalAt >= INTERVAL_REVISION_MS;
}
