/**
 * R011 Stage 1：从当前索引快照计算 pathMoves 的链接影响（纯函数内核）。
 * Memory / SQLite 实现共用，避免两套裁决分叉。
 */
import { applyPathMoves, relocateHref } from "./relocateHref.js";
import type { LinkRelocationImpact } from "./LinkIndex.js";
import type { DocumentLink } from "./types.js";

export interface RelocationAnalysisDoc {
  noteKey: string;
  relativePath: string;
  versionToken: string;
  links: DocumentLink[];
}

/**
 * 对 vault 内全部文档的出站 internal/asset 链接，按 pathMoves 计算需改写项。
 * oldHref==newHref（路径等价）的条目不产出。
 */
export function computeRelocationImpacts(
  documents: Iterable<RelocationAnalysisDoc>,
  pathMoves: Array<{
    noteKey: string;
    fromRelativePath: string;
    toRelativePath: string;
  }>,
): LinkRelocationImpact[] {
  const moves = pathMoves.map((m) => ({
    fromRelativePath: m.fromRelativePath,
    toRelativePath: m.toRelativePath,
  }));
  // noteKey → 未来路径（精确文档移动）。
  const keyFuture = new Map(
    pathMoves.map((m) => [m.noteKey, m.toRelativePath] as const),
  );

  const impacts: LinkRelocationImpact[] = [];

  for (const doc of documents) {
    const futureSource =
      keyFuture.get(doc.noteKey) ??
      applyPathMoves(doc.relativePath, moves);

    for (const link of doc.links) {
      if (link.kind !== "internal" && link.kind !== "asset") continue;
      // 无目标路径无法计算相对关系（broken 逃逸 / 空）。
      if (!link.targetRelativePath) continue;

      const futureTarget =
        (link.targetPageId
          ? keyFuture.get(link.targetPageId)
          : undefined) ??
        applyPathMoves(link.targetRelativePath, moves);

      const { newHref, changed } = relocateHref({
        sourcePathBefore: doc.relativePath,
        targetPathBefore: link.targetRelativePath,
        sourcePathAfter: futureSource,
        targetPathAfter: futureTarget,
        oldHref: link.href,
      });
      if (!changed) continue;

      impacts.push({
        sourcePageId: doc.noteKey,
        sourceRelativePath: doc.relativePath,
        futureSourceRelativePath: futureSource,
        targetPageId: link.targetPageId,
        targetRelativePath: link.targetRelativePath,
        futureTargetRelativePath: futureTarget,
        kind: link.kind,
        oldHref: link.href,
        newHref,
        sourceVersion: link.sourceVersion || doc.versionToken,
      });
    }
  }

  return impacts;
}
