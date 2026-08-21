/**
 * 全文搜索契约的内存参照实现（R008 Stage 3）：可替换性证明 +
 * 契约测试参照（src/test/searchIndexContract.ts 的「内存实现」一方，
 * Stage 4 的 Desktop SQLite 实现复跑同一套件）。
 *
 * 查询语义完全委托 SearchContract 的纯函数（rankSearchDocuments），
 * 本类只提供 vault 分桶存储与状态模型——这正是 Stage 4 推荐的
 * 「存储/召回 + 契约层精排」分层方式的最小形态。
 *
 * 状态模型：未知 vault → missing；prepareWorkspace/upsert（懒创建）/
 * rebuild 后 → ready。内存实现天然无 degraded/corrupt 路径
 * （无磁盘、无外部资源），契约测试不约束这两态。
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
import { rankSearchDocuments } from "../../application/services/SearchContract";

export class InMemoryFullTextSearchIndex implements FullTextSearchIndexPort {
  /** vaultId → (pageId → 源文档)。查询时实时归一化，无额外派生结构。 */
  private readonly byVault = new Map<string, Map<string, SearchDocument>>();

  prepareWorkspace(vaultId: string): Promise<void> {
    this.ensureVault(vaultId);
    return Promise.resolve();
  }

  search(input: SearchQueryInput): Promise<SearchResult[]> {
    const documents =
      input.vaultId === undefined
        ? [...this.byVault.values()].flatMap((bucket) => [...bucket.values()])
        : [...(this.byVault.get(input.vaultId)?.values() ?? [])];
    return Promise.resolve(
      rankSearchDocuments(documents, input.query, input.limit),
    );
  }

  upsert(doc: SearchDocument): Promise<void> {
    // 防御性拷贝：调用方后续修改 doc/tags 不影响索引内容。
    this.ensureVault(doc.vaultId).set(doc.pageId, {
      ...doc,
      tags: [...doc.tags],
    });
    return Promise.resolve();
  }

  remove(input: SearchRemoveInput): Promise<void> {
    this.byVault.get(input.vaultId)?.delete(input.pageId);
    return Promise.resolve();
  }

  rebuild(vaultId: string): Promise<SearchRebuildResult> {
    const startedAt = performance.now();
    const bucket = this.ensureVault(vaultId);
    // 重建 = 从留存的源文档重新派生索引；内存实现查询时实时归一化，
    // 派生结构即源表本身，故重建体现为源表整体替换（丢弃旧桶）。
    this.byVault.set(vaultId, new Map(bucket));
    return Promise.resolve({
      indexedDocuments: bucket.size,
      durationMs: performance.now() - startedAt,
    });
  }

  getStatus(vaultId: string): Promise<SearchIndexStatus> {
    const bucket = this.byVault.get(vaultId);
    return Promise.resolve(
      bucket
        ? { state: "ready", indexedDocuments: bucket.size }
        : { state: "missing" },
    );
  }

  private ensureVault(vaultId: string): Map<string, SearchDocument> {
    let bucket = this.byVault.get(vaultId);
    if (!bucket) {
      bucket = new Map();
      this.byVault.set(vaultId, bucket);
    }
    return bucket;
  }
}
