/**
 * R012 Stage 1（需求 §26）：interval 快照自动裁剪。
 *
 * 策略常量与确定性选择规则的单一实现在 shared/revisions/retention.ts
 * （electron 不得 import src/domain，故由 shared 承载、domain re-export）：
 * keep=100、maxBytes=5MiB、最新 interval 恒保留至少 1 个。
 *
 * 只处理 reason === "interval" 的快照；manual / before-restore 永不自动
 * 删除。删除是物理删除 revision 目录（manifest.json + body.md），
 * 不可恢复。
 */
import {
  INTERVAL_REVISION_KEEP,
  INTERVAL_REVISION_MAX_BYTES,
  selectRevisionsToPrune,
} from "../../../shared/revisions/retention.js";
import type { DesktopRevisionStore } from "./DesktopRevisionStore.js";

export interface PruneIntervalResult {
  /** 被物理删除的 revisionId（由新到旧）。 */
  pruned: string[];
}

/**
 * 裁剪单个 series 的 interval 快照。
 * list 已按 createdAt 倒序（最新在前），直接喂给确定性选择规则。
 * 损坏条目（degraded）不参与计量也不删除——交给人工/后续治理。
 */
export async function pruneIntervalRevisions(
  store: DesktopRevisionStore,
  seriesId: string,
  keep: number = INTERVAL_REVISION_KEEP,
  maxBytes: number = INTERVAL_REVISION_MAX_BYTES,
): Promise<PruneIntervalResult> {
  const { revisions } = await store.list(seriesId);
  const intervalDesc = revisions
    .filter((r) => r.reason === "interval")
    .map((r) => ({ id: r.revisionId, bytes: r.bodyBytes }));
  const excess = selectRevisionsToPrune(intervalDesc, keep, maxBytes);
  for (const revision of excess) {
    await store.removeRevision(seriesId, revision.id);
  }
  return { pruned: excess.map((r) => r.id) };
}
