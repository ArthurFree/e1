/**
 * R008 Stage 4（§11，R8-04）：Desktop 全文搜索索引——
 * FullTextSearchIndexPort 的 IPC-backed 实现。
 *
 * 查询与索引都在 Main（electron/main/search/，node:sqlite 派生库，
 * userData/search-index/）；本类只做桥接透传，线格式与契约类型同形
 * （shared/search/model 为唯一来源）。桥错误（解码后的 DesktopIpcError）
 * 原样上抛——调用方（SearchPanel）按 §20 回退标题搜索；索引内部失败
 * 由 Main 经 getStatus 的 degraded/corrupt 表达，不走异常通道（R8-06）。
 *
 * 与既有标题搜索 DesktopTitleSearchIndex（旧 SearchIndexPort）并存：
 * 旧链路装配不动，新 port 经 AppServices.fullTextSearchIndex 可选注入，
 * 消费侧以「port 存在」门控（DUAL-01：不判断平台名称）。
 */
import type {
  FullTextSearchIndexPort,
  SearchDocument,
  SearchIndexStatus,
  SearchQueryInput,
  SearchRebuildResult,
  SearchRemoveInput,
  SearchResult,
} from "../../application/services/SearchContract";
import type { E1DesktopAPI } from "./desktopApi";

export class DesktopFullTextSearchIndex implements FullTextSearchIndexPort {
  constructor(private readonly api: E1DesktopAPI) {}

  async prepareWorkspace(vaultId: string): Promise<void> {
    await this.api.search.prepare({ vaultId });
  }

  search(input: SearchQueryInput): Promise<SearchResult[]> {
    return this.api.search.query(input);
  }

  async upsert(doc: SearchDocument): Promise<void> {
    await this.api.search.upsert({ doc });
  }

  async remove(input: SearchRemoveInput): Promise<void> {
    await this.api.search.remove(input);
  }

  rebuild(vaultId: string): Promise<SearchRebuildResult> {
    return this.api.search.rebuild({ vaultId });
  }

  getStatus(vaultId: string): Promise<SearchIndexStatus> {
    return this.api.search.getStatus({ vaultId });
  }
}
