/**
 * R012 Stage 1（需求 §26）：版本历史 retention 策略的单一实现。
 *
 * 原位于 src/domain/revisions.ts；electron 不得 import src
 * （.dependency-cruiser.js 的 electron-no-src 规则），Desktop Main 侧的
 * retention 也需要同一套规则，故常量与确定性裁剪逻辑上移到 shared/
 * （零依赖、环境中立），src/domain/revisions.ts re-export 保持 Web 侧
 * 调用点不变。
 *
 * 策略口径：
 * - 自动裁剪只处理 reason === "interval" 的快照；
 * - manual / before-restore 永不自动删除；
 * - 最新 interval 快照恒保留（即使其自身超过字节预算）；
 * - 超出数量/字节上限后最旧的先删，且一旦超出即删除剩余全部更旧版本
 *   （确定性，不依赖各版本大小的排列组合）。
 */

/** 每篇文档保留的自动（interval）版本数量上限。 */
export const INTERVAL_REVISION_KEEP = 100;

/** 单文档自动（interval）版本总字节预算（超出后最旧的先删）。 */
export const INTERVAL_REVISION_MAX_BYTES = 5 * 1024 * 1024;

/**
 * 确定性裁剪规则（R004 §6.4）：版本按创建时间倒序（最新在前），
 * 最新版本始终保留；此后逐个保留直到数量达 keep 或累计字节超 maxBytes，
 * 一旦超出即删除剩余全部更旧版本。
 * @param intervalDesc interval 版本按创建时间倒序（最新在前），bytes 为各自字节数。
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
