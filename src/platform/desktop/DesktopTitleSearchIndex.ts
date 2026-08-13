/**
 * R006-C4 §53：Desktop 标题搜索索引——包装底层 SearchIndexPort，
 * updateText 为 no-op，避免「保存过一次才能搜正文」的半完整体验。
 * 全文搜索属后续 Desktop 数据层（SQLite FTS）。
 */
import type { Page, SearchResult } from "../../domain/types";
import type {
  SearchIndexPort,
  SearchIndexUpsertInput,
} from "../../application/services/SearchIndexPort";

export class DesktopTitleSearchIndex implements SearchIndexPort {
  constructor(private readonly inner: SearchIndexPort) {}

  prepareWorkspace(workspaceId: string): Promise<void> {
    return this.inner.prepareWorkspace(workspaceId);
  }

  rebuild(workspaceId: string): Promise<void> {
    return this.inner.rebuild(workspaceId);
  }

  syncPages(workspaceId: string, pages: Page[]): Promise<void> {
    return this.inner.syncPages(workspaceId, pages);
  }

  upsertDocument(input: SearchIndexUpsertInput): Promise<void> {
    // 丢弃 textSnapshot，只维护标题元数据。
    return this.inner.upsertDocument({
      workspaceId: input.workspaceId,
      pageId: input.pageId,
      title: input.title,
      kind: input.kind,
      updatedAt: input.updatedAt,
      deletedAt: input.deletedAt,
    });
  }

  async updateText(): Promise<void> {
    // no-op：C4 不开放正文全文搜索。
  }

  removeDocument(workspaceId: string, pageId: string): Promise<void> {
    return this.inner.removeDocument(workspaceId, pageId);
  }

  has(workspaceId: string): boolean {
    return this.inner.has(workspaceId);
  }

  query(workspaceId: string, query: string): Promise<SearchResult[]> {
    return this.inner.query(workspaceId, query);
  }
}
