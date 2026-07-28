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
/**
 * 单文档自动（interval）版本总字节预算（R004 阶段 6，§6.4）：
 * 在数量上限之外同时按序列化字节裁剪，最旧的先删；
 * manual / before-restore 版本不参与自动清理。
 */
export const INTERVAL_REVISION_MAX_BYTES = 5 * 1024 * 1024;

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

/**
 * 确定性裁剪规则（R004 §6.4）：版本按创建时间倒序（最新在前），
 * 最新版本始终保留；此后逐个保留直到数量达 keep 或累计字节超 maxBytes，
 * 一旦超出即删除剩余全部更旧版本。
 * @param intervalDesc interval 版本按创建时间倒序（最新在前），bytes 为各自序列化字节数。
 * @returns 需要删除的版本（保持传入顺序，即由新到旧）。
 */
export function selectRevisionsToPrune<T extends { id: string }>(
  intervalDesc: (T & { bytes: number })[],
  keep: number,
  maxBytes: number,
): T[] {
  let kept = 0;
  let totalBytes = 0;
  for (let i = 0; i < intervalDesc.length; i += 1) {
    const revision = intervalDesc[i];
    const fits =
      kept === 0 || // 最新版本始终保留（即使其自身超过预算）。
      (kept < keep && totalBytes + revision.bytes <= maxBytes);
    if (fits) {
      kept += 1;
      totalBytes += revision.bytes;
    } else {
      // 首次超出后删除该版本及剩余全部更旧版本（确定性，不跳过大版本
      // 保留更小的旧版本——否则裁剪结果依赖各版本大小的排列组合）。
      return intervalDesc.slice(i);
    }
  }
  return [];
}
