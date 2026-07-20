import type { Page } from "./types";

export type DropZone = "before" | "inside" | "after";

/** 根据指针在行内的相对高度（0..1）判定放置区域：上/下各 1/4 为前/后，中间作为子级。 */
export function dropZoneAt(ratio: number): DropZone {
  if (ratio < 0.25) return "before";
  if (ratio > 0.75) return "after";
  return "inside";
}

export interface DropTarget {
  parentId: string | null;
  index: number;
}

/**
 * 计算页面树拖拽放置的目标父级与插入位置（index 基于不含被拖页的同级列表）。
 * 目标不存在、拖到自身或会形成环时返回 null。
 */
export function resolveDrop(
  pages: Page[],
  draggedId: string,
  targetId: string,
  zone: DropZone,
): DropTarget | null {
  if (draggedId === targetId) return null;
  const target = pages.find((p) => p.id === targetId);
  if (!target) return null;
  if (zone === "inside") {
    if (wouldCreateCycle(pages, draggedId, targetId)) return null;
    return {
      parentId: targetId,
      index: childrenOf(pages, targetId).filter((p) => p.id !== draggedId).length,
    };
  }
  if (wouldCreateCycle(pages, draggedId, target.parentId)) return null;
  const siblings = childrenOf(pages, target.parentId).filter(
    (p) => p.id !== draggedId,
  );
  const at = siblings.findIndex((p) => p.id === targetId);
  if (at === -1) return null;
  return { parentId: target.parentId, index: zone === "before" ? at : at + 1 };
}

/** 某父级下的未删除子页面，按 position 升序。 */
export function childrenOf(pages: Page[], parentId: string | null): Page[] {
  return pages
    .filter((p) => p.parentId === parentId && p.deletedAt === null)
    .sort((a, b) => a.position - b.position);
}

/** 新页面在同级中的 position：追加到末尾。 */
export function nextPosition(pages: Page[], parentId: string | null): number {
  const siblings = pages.filter((p) => p.parentId === parentId);
  if (siblings.length === 0) return 0;
  return Math.max(...siblings.map((p) => p.position)) + 1;
}

/** 把 pageId 移到 newParentId 下是否形成环（newParentId 是 pageId 自身或其后代）。 */
export function wouldCreateCycle(
  pages: Page[],
  pageId: string,
  newParentId: string | null,
): boolean {
  let cursor: string | null = newParentId;
  while (cursor !== null) {
    if (cursor === pageId) return true;
    const parent: Page | undefined = pages.find((p) => p.id === cursor);
    cursor = parent?.parentId ?? null;
  }
  return false;
}

/** 收集 pageId 及其全部后代 id（含已删除，供整棵子树操作）。 */
export function collectSubtreeIds(pages: Page[], pageId: string): string[] {
  const result = [pageId];
  const queue = [pageId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const child of pages.filter((p) => p.parentId === current)) {
      result.push(child.id);
      queue.push(child.id);
    }
  }
  return result;
}

/**
 * 把 pageId 移动到 newParentId 下的 index 位置，返回重排后的完整页面数组。
 * 新父级下的未删除同级 position 重编为 0..n-1；index 超出范围时收敛到两端；
 * 形成环时抛错。不修改 updatedAt（由调用方/仓储负责）。
 */
export function movePage(
  pages: Page[],
  id: string,
  newParentId: string | null,
  index: number,
): Page[] {
  const target = pages.find((p) => p.id === id);
  if (!target) throw new Error(`页面不存在: ${id}`);
  if (wouldCreateCycle(pages, id, newParentId)) {
    throw new Error("不能移动到自身或其子页面下");
  }
  const siblings = childrenOf(pages, newParentId).filter((p) => p.id !== id);
  const clamped = Math.max(0, Math.min(index, siblings.length));
  siblings.splice(clamped, 0, target);
  const order = new Map(siblings.map((p, i) => [p.id, i]));
  return pages.map((p) =>
    order.has(p.id)
      ? { ...p, parentId: newParentId, position: order.get(p.id) as number }
      : p,
  );
}
