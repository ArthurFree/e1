/**
 * R012 Stage 2（需求 §21/§33）：Desktop 版本历史仓储——
 * 领域 RevisionRepository 的 IPC-backed 真实实现
 *（替换 R006-C4-E 起 stubRepositories.ts 的 no-op stub）。
 *
 * 身份翻译链（§21）：
 *   pageId → DesktopVaultScanCache.findDocument(pageId)
 *         → {vaultId, relativePath, stableNoteId} → revision IPC
 * 找不到文档时按 stub 语义降级（listByPage → []、get → undefined、
 * add → null、pruneInterval → no-op），不 throw。
 *
 * REV-02（Desktop 权威快照是 raw Markdown body）：
 * - add() 的 contentJson/textSnapshot 被有意忽略——capture 由 Main 重读
 *   磁盘当前 Markdown 为准（§22），Renderer 不传任何正文（§44）；
 * - get() 返回的 DocumentRevision.contentJson 恒为 null：Desktop 恢复不走
 *   contentJson → controller.restore 链路，由 Stage 4 的
 *   RevisionRestorePort 承载；textSnapshot 即 raw Markdown body
 *  （供版本面板预览/diff，Stage 5）。
 *
 * 错误映射（与 repositories.ts 的 mapNoteReadError 同风格）：IPC 错误 →
 * DomainError；未识别的错误原样抛出。
 */
import { DomainError } from "../../domain/errors";
import type { RevisionRepository } from "../../domain/repositories";
import type {
  DocumentRevision,
  RevisionReason,
  RevisionSummary,
} from "../../domain/types";
import type {
  E1DesktopAPI,
  RevisionGetResult,
  RevisionSummaryDto,
} from "./desktopApi";
import { DesktopIpcError } from "./desktopApi";
import type { DesktopVaultScanCache } from "./DesktopVaultScanCache";

/** wire 摘要 → 领域 RevisionSummary（createdAt ISO → ms；bytes=bodyBytes）。 */
function toRevisionSummary(
  pageId: string,
  dto: RevisionSummaryDto,
): RevisionSummary {
  return {
    id: dto.revisionId,
    pageId,
    createdAt: Date.parse(dto.createdAt),
    reason: dto.reason,
    bytes: dto.bodyBytes,
    textPreview: dto.textPreview,
  };
}

/**
 * revision IPC 错误 → DomainError（DesktopIpcError.code 供程序判断）。
 * 其余未知错误原样抛出（与 mapNoteReadError 的 default 分支同口径）。
 */
function mapRevisionError(err: unknown): never {
  if (err instanceof DesktopIpcError) {
    switch (err.code) {
      case "NOTE_NOT_FOUND":
        throw new DomainError(
          "PAGE_NOT_FOUND",
          "这篇笔记已经不存在。它可能已经被其他程序移动或删除。",
        );
      case "VAULT_NOT_FOUND":
        throw new DomainError(
          "WORKSPACE_NOT_FOUND",
          "知识库目录不可访问，无法读取版本历史。",
        );
      case "VAULT_READ_ONLY":
        throw new DomainError("VAULT_READ_ONLY", err.message);
      case "DOCUMENT_CONFLICT":
        throw new DomainError("DOCUMENT_CONFLICT", err.message);
      case "NOT_IMPLEMENTED":
        throw new DomainError("NOT_IMPLEMENTED", err.message);
      default:
        throw err;
    }
  }
  throw err;
}

export class DesktopRevisionRepository implements RevisionRepository {
  constructor(
    private readonly api: E1DesktopAPI,
    private readonly scans: DesktopVaultScanCache,
  ) {}

  async listByPage(pageId: string): Promise<RevisionSummary[]> {
    const target = await this.locate(pageId);
    if (!target) return [];
    try {
      const result = await this.api.revisions.list(target);
      return result.summaries.map((dto) => toRevisionSummary(pageId, dto));
    } catch (err) {
      mapRevisionError(err);
    }
  }

  async get(
    pageId: string,
    revisionId: string,
  ): Promise<DocumentRevision | undefined> {
    const target = await this.locate(pageId);
    if (!target) return undefined;
    let result: RevisionGetResult | null;
    try {
      result = await this.api.revisions.get({ ...target, revisionId });
    } catch (err) {
      mapRevisionError(err);
    }
    if (result === null) return undefined;
    return {
      id: result.revisionId,
      pageId,
      // Desktop 恢复不走 contentJson（Stage 4 RevisionRestorePort）；
      // textSnapshot 为 raw Markdown body（预览/diff 用）。
      contentJson: null,
      textSnapshot: result.body,
      createdAt: Date.parse(result.createdAt),
      reason: result.reason,
    };
  }

  /**
   * 追加版本快照（§22）。contentJson/textSnapshot 有意忽略——Main 重读
   * 磁盘为准；与最新快照同 body 去重时返回 null。
   */
  async add(
    pageId: string,
    _contentJson: unknown,
    _textSnapshot: string,
    reason: RevisionReason,
  ): Promise<RevisionSummary | null> {
    const target = await this.locate(pageId);
    if (!target) return null;
    try {
      const captured = await this.api.revisions.capture({ ...target, reason });
      return captured === null ? null : toRevisionSummary(pageId, captured);
    } catch (err) {
      mapRevisionError(err);
    }
  }

  /** 裁剪 interval 快照（keep/maxBytes 缺省用 Main 侧策略常量）。 */
  async pruneInterval(
    pageId: string,
    keep: number,
    maxBytes?: number,
  ): Promise<void> {
    const target = await this.locate(pageId);
    if (!target) return;
    try {
      await this.api.revisions.prune({
        ...target,
        keep,
        ...(maxBytes !== undefined ? { maxBytes } : {}),
      });
    } catch (err) {
      mapRevisionError(err);
    }
  }

  /**
   * pageId → IPC 定位字段（vaultId + relativePath + stableNoteId）；
   * 未扫描到文档返回 null（调用方按 stub 语义降级）。
   */
  private async locate(
    pageId: string,
  ): Promise<{
    vaultId: string;
    relativePath: string;
    stableNoteId: string | null;
  } | null> {
    const found = await this.scans.findDocument(pageId);
    if (!found) return null;
    return {
      vaultId: found.vaultId,
      relativePath: found.entry.relativePath,
      stableNoteId: found.entry.noteId,
    };
  }
}
