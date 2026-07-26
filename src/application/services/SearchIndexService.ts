/**
 * 工作区级内存搜索索引（R003 阶段 7）：
 * 会话加载时一次构建，页面写操作与正文保存增量同步，
 * 查询不再每次全量扫描 pages + content.listAll()。
 *
 * 语义与 domain/search.ts 的 searchPages 完全一致（标题命中在前、
 * 回收站排除、分组只匹配标题、snippet 截取规则），等价性由测试强制。
 * 条目同时保存原文（snippet 用）与小写化文本（匹配用）。
 */
import { makeSnippet } from "../../domain/search";
import { trackTiming } from "../devDiagnostics";
import type {
  DocumentContent,
  Page,
  PageKind,
  SearchResult,
} from "../../domain/types";

/** 索引条目：原文 + 规范化文本 + 匹配所需的页面元数据。 */
export interface SearchIndexEntry {
  pageId: string;
  /** 展示用原标题（含「无标题」回退）。 */
  title: string;
  titleNormalized: string;
  /** snippet 用正文原文。 */
  textSnapshot: string;
  textNormalized: string;
  kind: PageKind;
  deletedAt: number | null;
  updatedAt: number;
}

function entryOf(page: Page, textSnapshot: string): SearchIndexEntry {
  const title = page.title || "无标题";
  return {
    pageId: page.id,
    title,
    titleNormalized: title.toLowerCase(),
    textSnapshot,
    textNormalized: textSnapshot.toLowerCase(),
    kind: page.kind,
    deletedAt: page.deletedAt,
    updatedAt: page.updatedAt,
  };
}

/** 工作区级搜索索引：按 workspaceId 分桶，pageId 定位条目。 */
export class SearchIndexService {
  private byWorkspace = new Map<string, Map<string, SearchIndexEntry>>();
  private workspaceOf = new Map<string, string>();

  /** 会话加载后全量（重）构建一个工作区的索引。 */
  build(workspaceId: string, pages: Page[], contents: DocumentContent[]): void {
    // 清理旧桶的反向映射。
    const old = this.byWorkspace.get(workspaceId);
    if (old) {
      for (const id of old.keys()) this.workspaceOf.delete(id);
    }
    const textByPageId = new Map(contents.map((c) => [c.pageId, c.textSnapshot]));
    const entries = new Map<string, SearchIndexEntry>();
    for (const page of pages) {
      entries.set(page.id, entryOf(page, textByPageId.get(page.id) ?? ""));
      this.workspaceOf.set(page.id, workspaceId);
    }
    this.byWorkspace.set(workspaceId, entries);
  }

  /**
   * 页面写操作后同步该工作区的索引：upsert 列表内页面、移除列表外条目
   * （保留各条目已索引的正文文本，只刷新页面元数据）。
   */
  syncPages(workspaceId: string, pages: Page[]): void {
    const entries = this.byWorkspace.get(workspaceId);
    if (!entries) return;
    const seen = new Set<string>();
    for (const page of pages) {
      seen.add(page.id);
      const text = entries.get(page.id)?.textSnapshot ?? "";
      entries.set(page.id, entryOf(page, text));
      this.workspaceOf.set(page.id, workspaceId);
    }
    for (const id of [...entries.keys()]) {
      if (!seen.has(id)) {
        entries.delete(id);
        this.workspaceOf.delete(id);
      }
    }
  }

  /** 单页面元数据更新（重命名等不刷新整库列表的路径）。 */
  upsertPage(page: Page): void {
    const entries = this.byWorkspace.get(page.workspaceId);
    if (!entries) return;
    const text = entries.get(page.id)?.textSnapshot ?? "";
    entries.set(page.id, entryOf(page, text));
    this.workspaceOf.set(page.id, page.workspaceId);
  }

  /** 正文保存后增量更新文本（由 SaveCoordinator 的成功保存回调驱动）。 */
  updateText(pageId: string, textSnapshot: string, updatedAt: number): void {
    const wsId = this.workspaceOf.get(pageId);
    const entry = wsId ? this.byWorkspace.get(wsId)?.get(pageId) : undefined;
    if (!entry) return;
    entry.textSnapshot = textSnapshot;
    entry.textNormalized = textSnapshot.toLowerCase();
    entry.updatedAt = updatedAt;
  }

  has(workspaceId: string): boolean {
    return this.byWorkspace.has(workspaceId);
  }

  /** 查询：语义与 searchPages 一致（标题命中在前，组内保持构建顺序）。 */
  query(workspaceId: string, query: string): SearchResult[] {
    const t0 = performance.now();
    const q = query.trim().toLowerCase();
    if (q === "") return [];
    const entries = this.byWorkspace.get(workspaceId);
    if (!entries) return [];
    const titleHits: SearchResult[] = [];
    const bodyHits: SearchResult[] = [];
    for (const entry of entries.values()) {
      if (entry.deletedAt !== null) continue;
      if (entry.titleNormalized.includes(q)) {
        titleHits.push({
          pageId: entry.pageId,
          title: entry.title,
          snippet: makeSnippet(entry.textSnapshot, q),
        });
      } else if (entry.kind === "document" && entry.textNormalized.includes(q)) {
        bodyHits.push({
          pageId: entry.pageId,
          title: entry.title,
          snippet: makeSnippet(entry.textSnapshot, q),
        });
      }
    }
    trackTiming("search-query", performance.now() - t0);
    return [...titleHits, ...bodyHits];
  }
}
