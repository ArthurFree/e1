/**
 * R008 Stage 4（§11，R8-04）：Desktop 全文搜索索引——
 * FullTextSearchIndex port 的 IPC-backed 实现。
 *
 * 索引本体在 Main（node:sqlite，userData/search-index/）；本类只做：
 * - 调用转发（query/rebuild/upsert/remove/relocate/status）；
 * - 身份翻译：Main 结果行的稳定键（stableNoteId ?? path:<rel>）→
 *   会话页面 id（Adoption 别名解析，与扫描缓存同一口径）；
 * - 状态镜像：getStatus 同步语义由会话内缓存满足（操作后更新，
 *   外部事件经 refreshStatus 刷新，Stage 5 reconciler 驱动）。
 */
import type {
  FullTextSearchIndex,
  FullTextSearchInput,
  FullTextSearchResult,
  SearchDocument,
} from "../../application/search/FullTextSearchIndex";
import type { SearchIndexStatus } from "../../application/search/SearchIndexStatus";
import type { SearchQueryRow } from "./desktopApi";
import type { E1DesktopAPI } from "./desktopApi";
import type { DesktopVaultScanCache } from "./DesktopVaultScanCache";

export class DesktopSearchIndex implements FullTextSearchIndex {
  private readonly statusCache = new Map<string, SearchIndexStatus>();

  constructor(
    private readonly api: E1DesktopAPI,
    private readonly scans: DesktopVaultScanCache,
  ) {}

  async rebuild(vaultId: string): Promise<void> {
    const result = await this.api.search.rebuild({ vaultId });
    this.statusCache.set(vaultId, {
      state: "ready",
      indexedDocuments: result.indexedDocuments,
    });
  }

  async search(input: FullTextSearchInput): Promise<FullTextSearchResult[]> {
    const rows = await this.api.search.query(input);
    return rows.map((row) => ({
      pageId: this.toSessionPageId(input.vaultId, row),
      title: row.title,
      matchedField: row.matchedField,
      snippet: row.snippet,
      score: row.score,
      relativePath: row.relativePath,
    }));
  }

  /** Main 稳定键 → 会话页面 id（Adoption 别名；无别名时原样返回）。 */
  private toSessionPageId(
    vaultId: string | undefined,
    row: SearchQueryRow,
  ): string {
    if (!vaultId) return row.pageId;
    const alias =
      this.scans.aliases.getByRelativePath(vaultId, row.relativePath) ??
      (row.stableNoteId
        ? this.scans.aliases.getByStableNoteId(row.stableNoteId)
        : null);
    return alias?.vaultId === vaultId ? alias.sessionPageId : row.pageId;
  }

  async upsert(document: SearchDocument): Promise<void> {
    const result = await this.api.search.upsert({
      vaultId: document.vaultId,
      relativePath: document.relativePath,
    });
    // 文件已消失（与 deleted 竞态）：按删除收口（R8-06 不抛错）。
    if (!result.indexed) {
      await this.api.search.remove({
        vaultId: document.vaultId,
        relativePath: document.relativePath,
      });
    }
  }

  async remove(input: { vaultId: string; pageId: string }): Promise<void> {
    const relativePath = this.relativePathOf(input.vaultId, input.pageId);
    if (!relativePath) return;
    await this.api.search.remove({
      vaultId: input.vaultId,
      relativePath,
    });
  }

  async relocate(input: {
    vaultId: string;
    pageId: string;
    relativePath: string;
  }): Promise<void> {
    const from = this.relativePathOf(input.vaultId, input.pageId);
    if (!from) return;
    await this.api.search.relocate({
      vaultId: input.vaultId,
      from,
      to: input.relativePath,
    });
  }

  /** 页面 id → 当前相对路径（扫描缓存索引 + path: 前缀回退）。 */
  private relativePathOf(vaultId: string, pageId: string): string | null {
    const cached = this.scans.getRelativePathSync(vaultId, pageId);
    if (cached) return cached;
    return pageId.startsWith("path:") ? pageId.slice("path:".length) : null;
  }

  getStatus(vaultId: string): SearchIndexStatus {
    return this.statusCache.get(vaultId) ?? { state: "missing" };
  }

  /** 刷新状态镜像（Stage 5：外部变更 reconciliation / 会话加载后）。 */
  async refreshStatus(vaultId: string): Promise<void> {
    this.statusCache.set(vaultId, await this.api.search.status({ vaultId }));
  }
}
