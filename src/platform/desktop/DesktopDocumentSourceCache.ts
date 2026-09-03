/**
 * R006-C4-D（FR-17/18/19）+ C4-E 会话授权：Desktop 文档打开时的来源上下文缓存。
 *
 * 打开瞬间从 note.read + MarkdownCodec.parse 记下 Frontmatter / 换行 /
 * BOM / 稳定 ID / 兼容性，供保存时 serialize「从哪来回哪去」——不必再猜。
 * 会话级内存 Map；Vault 关闭或 invalidate 时清理。
 */
import type { DocumentWriteSessionState } from "../../application/queries/documentWritePolicy";
import { createEmptyWriteSessionState } from "../../application/queries/documentWritePolicy";
import type { ContentVersionToken } from "../../domain/types";
import type {
  FrontmatterExtraField,
  PortableNoteMetadata,
  UnsupportedMarkdownFeature,
} from "../../editor/markdown/types";

/** 单篇文档的打开来源上下文（R006-C4 FR-17）。 */
export interface DesktopDocumentSourceContext {
  vaultId: string;
  /** 当前会话 Page.id（可能是 path:*）。 */
  sessionPageId: string;
  relativePath: string;
  /** Frontmatter id；缺失为 null（尚未 Adoption）。 */
  stableNoteId: string | null;
  metadata: PortableNoteMetadata;
  frontmatterExtra: FrontmatterExtraField[];
  lineEnding: "lf" | "crlf";
  hadUtf8Bom: boolean;
  versionToken: ContentVersionToken;
  compatibility: {
    lossy: boolean;
    unsupported: UnsupportedMarkdownFeature[];
  };
  /** 当前打开会话的写入授权（FR-04，不永久记忆）。 */
  writeSession: DocumentWriteSessionState;
}

/**
 * 打开文档时记录的来源上下文缓存（FR-18）。
 * pageId → context；同一会话内保存走此缓存，不重新猜 Frontmatter。
 */
export class DesktopDocumentSourceCache {
  private readonly byPageId = new Map<string, DesktopDocumentSourceContext>();

  get(pageId: string): DesktopDocumentSourceContext | null {
    return this.byPageId.get(pageId) ?? null;
  }

  set(pageId: string, context: DesktopDocumentSourceContext): void {
    this.byPageId.set(pageId, {
      ...context,
      writeSession: context.writeSession ?? createEmptyWriteSessionState(),
    });
  }

  updateVersion(pageId: string, versionToken: ContentVersionToken): void {
    const existing = this.byPageId.get(pageId);
    if (!existing) return;
    this.byPageId.set(pageId, { ...existing, versionToken });
  }

  /** 更新即将 Adoption 的稳定 ID（C4-F）；会话 pageId 不变。 */
  updateStableNoteId(pageId: string, stableNoteId: string): void {
    const existing = this.byPageId.get(pageId);
    if (!existing) return;
    this.byPageId.set(pageId, {
      ...existing,
      stableNoteId,
      metadata: { ...existing.metadata, id: stableNoteId },
    });
  }

  approveSourceLossy(pageId: string): void {
    this.patchWriteSession(pageId, { sourceLossyApproved: true });
  }

  approveOutputLossy(pageId: string): void {
    this.patchWriteSession(pageId, { outputLossyApproved: true });
  }

  approveIdentityAdoption(pageId: string): void {
    this.patchWriteSession(pageId, { identityAdoptionApproved: true });
  }

  private patchWriteSession(
    pageId: string,
    patch: Partial<DocumentWriteSessionState>,
  ): void {
    const existing = this.byPageId.get(pageId);
    if (!existing) return;
    this.byPageId.set(pageId, {
      ...existing,
      writeSession: { ...existing.writeSession, ...patch },
    });
  }

  /**
   * 外部移动后同步来源路径（R007 阶段 3 §3.4）：保存目标路径与
   * Mention/资源的相对路径解析都以缓存的 relativePath 为准，外部移动
   * 后不更新会把下次保存写回旧路径（在旧位置重建文件）。
   */
  updateRelativePath(pageId: string, relativePath: string): void {
    const existing = this.byPageId.get(pageId);
    if (!existing) return;
    this.byPageId.set(pageId, { ...existing, relativePath });
  }

  /** R011：分组移动/重命名后，按路径前缀批量 remap 来源缓存。 */
  remapPathPrefix(fromPrefix: string, toPrefix: string): void {
    const prefix = fromPrefix.endsWith("/") ? fromPrefix : `${fromPrefix}/`;
    for (const [pageId, ctx] of this.byPageId) {
      if (ctx.relativePath === fromPrefix) {
        this.byPageId.set(pageId, { ...ctx, relativePath: toPrefix });
      } else if (ctx.relativePath.startsWith(prefix)) {
        this.byPageId.set(pageId, {
          ...ctx,
          relativePath:
            toPrefix + ctx.relativePath.slice(fromPrefix.length),
        });
      }
    }
  }

  remove(pageId: string): void {
    this.byPageId.delete(pageId);
  }

  clearVault(vaultId: string): void {
    for (const [pageId, ctx] of this.byPageId) {
      if (ctx.vaultId === vaultId) this.byPageId.delete(pageId);
    }
  }

  clear(): void {
    this.byPageId.clear();
  }
}
