/**
 * 全局搜索纯逻辑：基于页面标题与 DocumentContent.textSnapshot 的大小写不敏感匹配。
 * textSnapshot 是搜索的唯一文本来源（contentJson 不参与检索），
 * 因此搜索结果天然与编辑器解耦，可在任意列表数据上运行。
 */

import type { DocumentContent, Page, SearchResult } from "./types";

/** 截取上下文片段时，命中处前后各保留的字符数。 */
const SNIPPET_RADIUS = 30;

/**
 * 以命中位置为中心截取上下文片段，两端超出时用省略号标示。
 * query 必须为已转小写的形式；未命中返回空串（调用方以空串表示「仅标题命中」）。
 */
function makeSnippet(text: string, query: string): string {
  const lower = text.toLowerCase();
  const hit = lower.indexOf(query);
  if (hit === -1) return "";
  const start = Math.max(0, hit - SNIPPET_RADIUS);
  const end = Math.min(text.length, hit + query.length + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/**
 * 全局搜索：大小写不敏感匹配标题与正文快照，排除回收站。
 * 分组只参与标题匹配；标题命中的结果排在前面。
 * 查询去空白后为空时返回 []；两组结果内部保持输入数组的顺序。
 */
export function searchPages(
  pages: Page[],
  contents: DocumentContent[],
  query: string,
): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const contentByPageId = new Map(contents.map((c) => [c.pageId, c]));
  const titleHits: SearchResult[] = [];
  const bodyHits: SearchResult[] = [];
  for (const page of pages) {
    if (page.deletedAt !== null) continue;
    const title = page.title || "无标题";
    const snapshot = contentByPageId.get(page.id)?.textSnapshot ?? "";
    if (title.toLowerCase().includes(q)) {
      titleHits.push({ pageId: page.id, title, snippet: makeSnippet(snapshot, q) });
    } else if (page.kind === "document" && snapshot.toLowerCase().includes(q)) {
      bodyHits.push({ pageId: page.id, title, snippet: makeSnippet(snapshot, q) });
    }
  }
  return [...titleHits, ...bodyHits];
}
