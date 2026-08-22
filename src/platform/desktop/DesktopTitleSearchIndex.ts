/**
 * R006-C4 §53：Desktop 标题搜索索引——包装底层 SearchIndexPort，
 * updateText 为 no-op，避免「保存过一次才能搜正文」的半完整体验。
 * R008 Stage 5（§12.4）：可选 onCommitted 钩子——正文提交成功后
 *（commit/replaceContent → updateText、createWithContent → upsertDocument）
 * 通知全文索引 reconciler 做 best-effort upsert（自写不依赖 watcher，
 * 索引失败不影响正文保存）。
 */
import type { Page, SearchResult } from "../../domain/types";
import type {
  SearchIndexPort,
  SearchIndexUpsertInput,
} from "../../application/services/SearchIndexPort";

export class DesktopTitleSearchIndex implements SearchIndexPort {
  constructor(
    private readonly inner: SearchIndexPort,
    private readonly hooks?: {
      /** 正文提交成功（commit/replaceContent/createWithContent）后的通知。 */
      onCommitted?: (pageId: string) => void;
    },
  ) {}

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
    if (input.kind === "document") this.hooks?.onCommitted?.(input.pageId);
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

  async updateText(pageId: string): Promise<void> {
    this.hooks?.onCommitted?.(pageId);
    // 标题索引正文 no-op：全文由 DesktopSearchIndex（SQLite）承担。
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
