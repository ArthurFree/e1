/**
 * 搜索查询服务（R005 批次 1）：全局搜索编排从 WorkspaceProvider 下沉。
 *
 * 双路径（语义与 Provider 现状完全一致）：
 * - 工作区内存索引已构建（R003 阶段 7）：直接走 SearchIndexService.query；
 * - 索引未构建：回退 content.listAll() + domain searchPages 全量扫描
 *   （标题取调用方传入的内存镜像，含未落库的最新重命名）。
 *
 * 仓储经构造函数注入（domain port），不依赖 IndexedDB 具体实现。
 */
import type { ContentRepository } from "../../domain/repositories";
import { searchPages } from "../../domain/search";
import type { Page, SearchResult } from "../../domain/types";
import type { SearchIndexService } from "../services/SearchIndexService";

export class SearchQueryService {
  constructor(
    private readonly deps: {
      searchIndex: SearchIndexService;
      content: ContentRepository;
    },
  ) {}

  /** 工作区内搜索；workspaceId 为 null 或索引未构建时回退全量扫描。 */
  async query(
    workspaceId: string | null,
    pages: Page[],
    query: string,
  ): Promise<SearchResult[]> {
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
   */
  syncText(pageId: string, textSnapshot: string, updatedAt: number): void {
    this.deps.searchIndex.updateText(pageId, textSnapshot, updatedAt);
  }
}
