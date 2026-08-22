/**
 * 搜索查询服务（R005 批次 1）：全局搜索编排从 WorkspaceProvider 下沉。
 *
 * 双路径（语义与 Provider 现状完全一致）：
 * - 工作区索引已准备（R003 阶段 7）：直接走 SearchIndexPort.query
 *   （R005 阶段 6 起依赖 port，不再 import 具体搜索类）；
 * - 索引未准备：回退 content.listAll() + domain searchPages 全量扫描
 *   （标题取调用方传入的内存镜像，含未落库的最新重命名）。
 *
 * 仓储经构造函数注入（domain port），不依赖 IndexedDB 具体实现。
 */
import type { ContentRepository } from "../../domain/repositories";
import { searchPages } from "../../domain/search";
import type { Page, SearchResult } from "../../domain/types";
import { increment } from "../devDiagnostics";
import type { FullTextSearchIndex } from "../search/FullTextSearchIndex";
import type { SearchIndexPort } from "../services/SearchIndexPort";

export class SearchQueryService {
  constructor(
    private readonly deps: {
      searchIndex: SearchIndexPort;
      content: ContentRepository;
      /**
       * R008 Stage 4：全文搜索索引（Desktop 装配；ready 时优先消费，
       * 未装配/未 ready 回退既有 SearchIndexPort/全量扫描路径）。
       */
      fullText?: FullTextSearchIndex;
    },
  ) {}

  /** 工作区内搜索；workspaceId 为 null 或索引未准备时回退全量扫描。 */
  async query(
    workspaceId: string | null,
    pages: Page[],
    query: string,
  ): Promise<SearchResult[]> {
    // R008：Desktop 全文索引 ready 时走 title/tags/body 全文检索。
    if (
      workspaceId &&
      this.deps.fullText &&
      this.deps.fullText.getStatus(workspaceId).state === "ready"
    ) {
      const results = await this.deps.fullText.search({
        vaultId: workspaceId,
        query,
      });
      return results.map((r) => ({
        pageId: r.pageId,
        title: r.title,
        snippet: r.snippet ?? "",
      }));
    }
    if (workspaceId && this.deps.searchIndex.has(workspaceId)) {
      return this.deps.searchIndex.query(workspaceId, query);
    }
    const contents = await this.deps.content.listAll();
    return searchPages(pages, contents, query);
  }

  /**
   * 增量同步索引文本（R005 批次 2 从 MainArea 迁入）：跨标签页
   * content-saved 后刷新非当前文档的索引；索引维护与搜索同驻本服务
   * （与 WorkspaceQueryService.loadSession/loadPages 的索引同步一致）。
   *
   * port 为异步签名（R005 阶段 6），Web 内存实现同步完成；本方法保持
   * 同步 fire-and-forget——失败仅记录诊断，索引是派生数据，不影响
   * 编辑主流程。
   */
  syncText(pageId: string, textSnapshot: string, updatedAt: number): void {
    void this.deps.searchIndex
      .updateText(pageId, textSnapshot, updatedAt)
      .catch(() => increment("search-index", "sync-failed"));
  }
}
