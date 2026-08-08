/**
 * Web 内存搜索索引（R005 阶段 6；自 application/services/SearchIndexService
 * 迁入并实现 SearchIndexPort）：按工作区分桶的纯内存 Map 索引。
 *
 * - prepareWorkspace/rebuild 自行经注入的仓储取数（页面元数据 +
 *   正文快照均按工作区索引直取），会话加载因此不再携带全部正文；
 * - 页面写操作经 syncPages/upsertDocument 增量同步，正文保存经
 *   updateText 增量同步，查询不再每次全量扫描 pages + content.listAll()；
 * - 语义与 domain/search.ts 的 searchPages 完全一致（标题命中在前、
 *   回收站排除、分组只匹配标题、snippet 截取规则），等价性由测试强制；
 * - 条目同时保存原文（snippet 用）与小写化文本（匹配用）。
 *
 * 本实现全部操作同步完成（port 的 Promise 签名为未来 SQLite 等异步
 * 实现预留）；不触碰任何浏览器 API，内存测试容器复用同一实现。
 */
import { makeSnippet } from "../../../domain/search";
import type {
  ContentRepository,
  PageRepository,
} from "../../../domain/repositories";
import type {
  DocumentContent,
  Page,
  PageKind,
  SearchResult,
} from "../../../domain/types";
import { trackTiming } from "../../../application/devDiagnostics";
import type {
  SearchIndexPort,
  SearchIndexUpsertInput,
} from "../../../application/services/SearchIndexPort";

/** 索引条目：原文 + 规范化文本 + 匹配所需的页面元数据。 */
interface SearchIndexEntry {
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
  return {
    pageId: page.id,
    ...normalize(
      page.title,
      textSnapshot,
      page.kind,
      page.deletedAt,
      page.updatedAt,
    ),
  };
}

function normalize(
  title: string,
  textSnapshot: string,
  kind: PageKind,
  deletedAt: number | null,
  updatedAt: number,
): Omit<SearchIndexEntry, "pageId"> {
  const displayTitle = title || "无标题";
  return {
    title: displayTitle,
    titleNormalized: displayTitle.toLowerCase(),
    textSnapshot,
    textNormalized: textSnapshot.toLowerCase(),
    kind,
    deletedAt,
    updatedAt,
  };
}

/** 工作区级搜索索引：按 workspaceId 分桶，pageId 定位条目。 */
export class BrowserMemorySearchIndex implements SearchIndexPort {
  private byWorkspace = new Map<string, Map<string, SearchIndexEntry>>();
  private workspaceOf = new Map<string, string>();

  /**
   * 取数仓储（R005 阶段 6）：索引自行读取页面与正文快照，
   * 会话服务因此无需加载全部正文。
   */
  constructor(
    private readonly deps: {
      pages: PageRepository;
      content: ContentRepository;
    },
  ) {}

  /** 全量（重）构建一个工作区的索引；幂等，重复调用等价于 rebuild。 */
  async prepareWorkspace(workspaceId: string): Promise<void> {
    const [pages, contents] = await Promise.all([
      this.deps.pages.listByWorkspace(workspaceId),
      this.deps.content.listByWorkspace(workspaceId),
    ]);
    this.buildFromData(workspaceId, pages, contents);
  }

  /** 内存实现的重建即重跑 prepareWorkspace（旧桶整桶替换）。 */
  rebuild(workspaceId: string): Promise<void> {
    return this.prepareWorkspace(workspaceId);
  }

  private buildFromData(
    workspaceId: string,
    pages: Page[],
    contents: DocumentContent[],
  ): void {
    // 清理旧桶的反向映射。
    const old = this.byWorkspace.get(workspaceId);
    if (old) {
      for (const id of old.keys()) this.workspaceOf.delete(id);
    }
    const textByPageId = new Map(
      contents.map((c) => [c.pageId, c.textSnapshot]),
    );
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
  syncPages(workspaceId: string, pages: Page[]): Promise<void> {
    const entries = this.byWorkspace.get(workspaceId);
    if (!entries) return Promise.resolve();
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
    return Promise.resolve();
  }

  /**
   * 单文档 upsert（重命名/原子创建/软删/恢复等不刷新整库列表的路径）；
   * textSnapshot 缺省时保留已索引正文（纯元数据更新）。
   */
  upsertDocument(input: SearchIndexUpsertInput): Promise<void> {
    const entries = this.byWorkspace.get(input.workspaceId);
    if (!entries) return Promise.resolve();
    const textSnapshot =
      input.textSnapshot ?? entries.get(input.pageId)?.textSnapshot ?? "";
    entries.set(input.pageId, {
      pageId: input.pageId,
      ...normalize(
        input.title,
        textSnapshot,
        input.kind,
        input.deletedAt,
        input.updatedAt,
      ),
    });
    this.workspaceOf.set(input.pageId, input.workspaceId);
    return Promise.resolve();
  }

  /** 正文保存后增量更新文本（由保存协调器的成功提交驱动）。 */
  updateText(
    pageId: string,
    textSnapshot: string,
    updatedAt: number,
  ): Promise<void> {
    const wsId = this.workspaceOf.get(pageId);
    const entry = wsId ? this.byWorkspace.get(wsId)?.get(pageId) : undefined;
    if (!entry) return Promise.resolve();
    entry.textSnapshot = textSnapshot;
    entry.textNormalized = textSnapshot.toLowerCase();
    entry.updatedAt = updatedAt;
    return Promise.resolve();
  }

  /** 移除单条索引。 */
  removeDocument(workspaceId: string, pageId: string): Promise<void> {
    this.byWorkspace.get(workspaceId)?.delete(pageId);
    this.workspaceOf.delete(pageId);
    return Promise.resolve();
  }

  has(workspaceId: string): boolean {
    return this.byWorkspace.has(workspaceId);
  }

  /** 查询：语义与 searchPages 一致（标题命中在前，组内保持构建顺序）。 */
  query(workspaceId: string, query: string): Promise<SearchResult[]> {
    const t0 = performance.now();
    const q = query.trim().toLowerCase();
    if (q === "") return Promise.resolve([]);
    const entries = this.byWorkspace.get(workspaceId);
    if (!entries) return Promise.resolve([]);
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
      } else if (
        entry.kind === "document" &&
        entry.textNormalized.includes(q)
      ) {
        bodyHits.push({
          pageId: entry.pageId,
          title: entry.title,
          snippet: makeSnippet(entry.textSnapshot, q),
        });
      }
    }
    trackTiming("search-query", performance.now() - t0);
    return Promise.resolve([...titleHits, ...bodyHits]);
  }
}
