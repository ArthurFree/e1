/**
 * R012 Stage 4（需求 §23 Safe Restore）：Desktop 版本恢复 port 实现。
 *
 * 与 Web（JsonRevisionRestorePort）的根本差异：Desktop 的权威快照是
 * raw Markdown body（REV-02），恢复不经「contentJson → serialize → 写回」，
 * 而是 revision.restore IPC——Main 复核磁盘版本令牌（乐观锁）、保留当前
 * Frontmatter（仅 updated 推进）、拼回历史 raw body、AtomicFileWriter
 * 落盘。本类负责 Renderer 侧收口：
 *
 *   IPC 成功 → SourceCache 推进新令牌（updatedAt 同步）→
 *   DocumentVersionChannel 发布（打开中的保存协调器采纳新令牌，
 *   旧 autosave 不会拿旧令牌覆盖 restore）→ LinkIndex/SearchIndex
 *   显式 reconcile（不依赖 watcher；派生索引失败仅降级，不回滚正文，
 *   §43 Failure Model）。
 *
 * 返回 reloadedExternally=true：磁盘已被 Main 写入，调用方
 * （DocumentEditorController.restoreRevision）重新读盘重建编辑器。
 *
 * R012 Stage 5（需求 §27 Diff）：readCurrentSource 读磁盘当前 raw
 * Markdown body 作为 diff 对比源（与历史快照同口径，REV-02）；
 * Source Context 缺失或读取失败返回 null，协调器回退编辑器 textSnapshot。
 */
import { DomainError } from "../../domain/errors";
import { splitRawMarkdownBody } from "../../../shared/revisions/rawMarkdownBody";
import type {
  RevisionRestoreOutcome,
  RevisionRestorePort,
} from "../../application/services/RevisionRestoreCoordinator";
import type { DocumentVersionChannel } from "../../application/services/DocumentVersionChannel";
import type { LinkIndex } from "../../application/links/LinkIndex";
import type { FullTextSearchIndex } from "../../application/search/FullTextSearchIndex";
import { DesktopIpcError, type E1DesktopAPI } from "./desktopApi";
import type { DesktopDocumentSourceCache } from "./DesktopDocumentSourceCache";

/** revision.restore IPC 错误 → DomainError（与 mapNoteWriteError 同口径）。 */
function mapRestoreError(err: unknown): never {
  if (err instanceof DesktopIpcError) {
    switch (err.code) {
      case "NOTE_NOT_FOUND":
        // restore 通道的 NOTE_NOT_FOUND 语义为「版本缺失/损坏」或「文档已消失」，
        // 统一按版本不可恢复呈现。
        throw new DomainError("REVISION_NOT_FOUND", err.message);
      case "DOCUMENT_CONFLICT":
        throw new DomainError("DOCUMENT_CONFLICT", err.message, err.details);
      case "VAULT_READ_ONLY":
        throw new DomainError("VAULT_READ_ONLY", err.message);
      case "NOTE_WRITE_PERMISSION_DENIED":
        throw new DomainError("NOTE_WRITE_PERMISSION_DENIED", err.message);
      case "NOTE_WRITE_IO_ERROR":
        throw new DomainError("NOTE_WRITE_IO_ERROR", err.message);
      case "DOCUMENT_TOO_LARGE":
        throw new DomainError("DOCUMENT_TOO_LARGE", err.message, err.details);
      case "PATH_ESCAPE":
      case "INVALID_INPUT":
        throw new DomainError("INVALID_INPUT", err.message);
      default:
        throw err;
    }
  }
  throw err;
}

export class DesktopRevisionRestoreService implements RevisionRestorePort {
  constructor(
    private readonly deps: {
      api: E1DesktopAPI;
      sources: DesktopDocumentSourceCache;
      /** 版本推进通道（DSK-03）：restore 后打开中的协调器采纳新令牌。 */
      versionChannel: DocumentVersionChannel;
      /** 派生索引（可选）：显式 reconcile，不依赖 watcher。 */
      linkIndex?: LinkIndex;
      fullTextSearch?: FullTextSearchIndex;
    },
  ) {}

  /**
   * 当前正文对比源（R012 Stage 5 §27）：读磁盘整篇 Markdown 并剥离
   * Frontmatter，返回 raw body（与历史快照同口径）。Source Context
   * 缺失或 IPC 失败返回 null——diff 是只读增强，降级比报错好。
   */
  async readCurrentSource(pageId: string): Promise<string | null> {
    const ctx = this.deps.sources.get(pageId);
    if (!ctx) return null;
    try {
      const note = await this.deps.api.note.read({
        vaultId: ctx.vaultId,
        relativePath: ctx.relativePath,
      });
      return splitRawMarkdownBody(note.markdown).body;
    } catch {
      return null;
    }
  }

  async restore(
    input: Parameters<RevisionRestorePort["restore"]>[0],
  ): Promise<RevisionRestoreOutcome> {
    const ctx = this.deps.sources.get(input.pageId);
    if (!ctx) {
      throw new DomainError(
        "DOCUMENT_SOURCE_CONTEXT_REQUIRED",
        "该文档的本地来源信息已经失效，请重新打开后再恢复版本。",
      );
    }
    let written;
    try {
      written = await this.deps.api.revisions.restore({
        vaultId: ctx.vaultId,
        relativePath: ctx.relativePath,
        stableNoteId: ctx.stableNoteId,
        revisionId: input.target.id,
        expectedVersionToken: ctx.versionToken,
      });
    } catch (err) {
      mapRestoreError(err);
    }
    // SourceCache 推进（与 DesktopMarkdownWriteService.save 同口径）。
    this.deps.sources.updateVersion(input.pageId, written.versionToken);
    const latest = this.deps.sources.get(input.pageId);
    if (latest) {
      this.deps.sources.set(input.pageId, {
        ...latest,
        metadata: {
          ...latest.metadata,
          updatedAt: new Date(written.updatedAt).toISOString(),
        },
        versionToken: written.versionToken,
      });
    }
    // 打开中的保存协调器采纳新令牌（旧 autosave 不覆盖 restore）。
    this.deps.versionChannel.publish(input.pageId, written.versionToken);
    // 显式 reconcile（§23）：派生索引失败仅降级，不回滚已成功的正文恢复。
    await this.reconcile({
      pageId: input.pageId,
      vaultId: ctx.vaultId,
      relativePath: ctx.relativePath,
      stableNoteId: ctx.stableNoteId,
      versionToken: written.versionToken,
    });
    return { reloadedExternally: true };
  }

  /** LinkIndex/SearchIndex upsert（Main 读盘解析）；失败仅记录降级。 */
  private async reconcile(target: {
    pageId: string;
    vaultId: string;
    relativePath: string;
    stableNoteId: string | null;
    versionToken: string;
  }): Promise<void> {
    try {
      await this.deps.linkIndex?.upsert({
        vaultId: target.vaultId,
        relativePath: target.relativePath,
      });
    } catch {
      // 派生索引 degraded：允许 rebuild 恢复，不影响正文恢复结果。
    }
    try {
      // DesktopSearchIndex.upsert 只消费 vaultId/relativePath（Main 读盘），
      // 其余 SearchDocument 字段为满足契约的占位值。
      await this.deps.fullTextSearch?.upsert({
        pageId: target.pageId,
        vaultId: target.vaultId,
        stableNoteId: target.stableNoteId,
        relativePath: target.relativePath,
        title: "",
        tags: [],
        bodyText: "",
        createdAt: null,
        updatedAt: null,
        versionToken: target.versionToken,
      });
    } catch {
      // 同上：degraded，不回滚。
    }
  }
}
