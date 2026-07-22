/**
 * 活动与收藏列表纯逻辑：开始首页「最近动态」、最近浏览页、收藏页与知识库统计。
 * 只依赖 Page / Workspace / DocumentContent 数组，排序、归属路径与相对时间
 * 的展示规则全部集中在此，UI 不做二次加工。
 */

import type { DocumentContent, Page, Workspace } from "./types";

/** 活动区页签：编辑过（updatedAt）/ 浏览过（lastOpenedAt）。 */
export type ActivityTab = "edited" | "viewed";

/** 活动列表每页条数（前端分页）。 */
export const ACTIVITY_PAGE_SIZE = 30;

/** 活动列表的一行：页面本体加上渲染所需的派生字段。 */
export interface ActivityRow {
  page: Page;
  workspaceId: string;
  workspaceName: string;
  /** 归属路径：“知识库 / 分组 / 子分组”，不含文档自身。 */
  path: string;
  /** 用于排序与展示的时间（按页签取 updatedAt 或 lastOpenedAt）。 */
  time: number;
}

/** 归属路径：知识库名 + 祖先分组链；父级缺失或成环时安全截断。 */
export function belongingPath(
  page: Page,
  pagesById: Map<string, Page>,
  workspaceName: string,
): string {
  const groups: string[] = [];
  // guard 防御损坏数据中的父级环（A 的父级是 B、B 的父级又是 A），避免死循环。
  const guard = new Set<string>([page.id]);
  let current = page.parentId;
  while (current && !guard.has(current)) {
    guard.add(current);
    const parent = pagesById.get(current);
    if (!parent) break;
    if (parent.kind === "group") groups.unshift(parent.title || "未命名分组");
    current = parent.parentId;
  }
  return [workspaceName, ...groups].join(" / ");
}

/**
 * 跨知识库活动列表：只含未删除文档；“浏览过”排除无浏览时间的文档；
 * 按页签时间倒序，可按知识库筛选。
 * 页面所属知识库缺失时降级显示「未知知识库」，不丢弃该行。
 */
export function buildActivityRows(input: {
  pages: Page[];
  workspaces: Workspace[];
  tab: ActivityTab;
  workspaceId?: string | null;
}): ActivityRow[] {
  const { pages, workspaces, tab, workspaceId = null } = input;
  const wsById = new Map(workspaces.map((w) => [w.id, w]));
  const pagesById = new Map(pages.map((p) => [p.id, p]));
  const rows: ActivityRow[] = [];
  for (const page of pages) {
    if (page.kind !== "document" || page.deletedAt !== null) continue;
    if (workspaceId && page.workspaceId !== workspaceId) continue;
    const time = tab === "edited" ? page.updatedAt : page.lastOpenedAt;
    if (time === null) continue;
    const workspace = wsById.get(page.workspaceId);
    rows.push({
      page,
      workspaceId: page.workspaceId,
      workspaceName: workspace?.name ?? "未知知识库",
      path: belongingPath(page, pagesById, workspace?.name ?? "未知知识库"),
      time,
    });
  }
  return rows.sort((a, b) => b.time - a.time);
}

/** 相对时间：1 分钟内“刚刚”，7 天内 x 分钟/小时/天前，更早显示日期。 */
export function formatRelativeTime(now: number, timestamp: number): string {
  // 未来时间（时钟回拨等）按 0 处理，避免出现负数文案。
  const diff = Math.max(0, now - timestamp);
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  const date = new Date(timestamp);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${mm}-${dd}`;
}

/** 知识库统计：文档数（不含分组与回收站）与正文总字数（textSnapshot 字符数之和）。 */
export function workspaceDocStats(
  pages: Page[],
  contents: DocumentContent[],
  workspaceId: string,
): { docCount: number; totalChars: number } {
  const docIds = new Set(
    pages
      .filter(
        (p) =>
          p.workspaceId === workspaceId &&
          p.kind === "document" &&
          p.deletedAt === null,
      )
      .map((p) => p.id),
  );
  const totalChars = contents
    .filter((c) => docIds.has(c.pageId))
    .reduce((sum, c) => sum + c.textSnapshot.length, 0);
  return { docCount: docIds.size, totalChars };
}

/** 收藏的知识库：按收藏时间倒序。 */
export function favoriteWorkspaces(workspaces: Workspace[]): Workspace[] {
  return workspaces
    .filter((w) => w.favoriteAt !== null)
    .sort((a, b) => (b.favoriteAt ?? 0) - (a.favoriteAt ?? 0));
}

/** 收藏的文档：只含未删除文档，按收藏时间倒序；删除后保留时间但不展示。 */
export function favoritePages(pages: Page[]): Page[] {
  return pages
    .filter((p) => p.kind === "document" && p.deletedAt === null && p.favoriteAt !== null)
    .sort((a, b) => (b.favoriteAt ?? 0) - (a.favoriteAt ?? 0));
}
