import type { Page } from "./types";

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
