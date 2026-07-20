import type { DocumentContent, Page, SearchResult } from "./types";

const SNIPPET_RADIUS = 30;

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
 * 文件夹只参与标题匹配；标题命中的结果排在前面。
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
