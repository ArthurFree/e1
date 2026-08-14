/**
 * R007 阶段 1（DSK-03）：Desktop 元数据写入编排（Renderer 侧）。
 *
 * rename（标题）与 setPageTags（标签）共用的写入通道：
 *
 *   定位（scan 缓存反查 pageId → vaultId + relativePath）
 *   → 乐观锁起点（文档已打开取 Source Cache 的 versionToken，否则
 *     note.read 取磁盘当前版本）
 *   → note.patchMetadata（Main：expectedVersion 校验 + 原子写）
 *   → Source Cache 同步（metadata + versionToken，保证下一次正文
 *     autosave 序列化出新元数据且不拿旧令牌）
 *   → DocumentVersionChannel.publish（推进打开文档的协调器版本）
 *   → 扫描缓存失效（页面树/标签镜像重新反映磁盘真相）
 *
 * 错误经 mapNoteWriteError 映射为 DomainError（DOCUMENT_CONFLICT 等），
 * 与正文保存同一冲突语义。
 */
import { DomainError } from "../../domain/errors";
import type { DocumentVersionChannel } from "../../application/services/DocumentVersionChannel";
import { isTransientVaultId } from "../../application/queries/documentWritePolicy";
import type { E1DesktopAPI } from "./desktopApi";
import { DesktopIpcError } from "./desktopApi";
import { mapNoteWriteError } from "./DesktopMarkdownWriteService";
import type { DesktopDocumentSourceCache } from "./DesktopDocumentSourceCache";
import type { DesktopVaultScanCache } from "./DesktopVaultScanCache";

export interface NoteMetadataPatch {
  title?: string;
  tags?: string[];
}

export class DesktopNoteMetadataService {
  constructor(
    private readonly api: E1DesktopAPI,
    private readonly scans: DesktopVaultScanCache,
    private readonly sources: DesktopDocumentSourceCache,
    private readonly versions: DocumentVersionChannel,
  ) {}

  async patch(pageId: string, patch: NoteMetadataPatch): Promise<void> {
    const found = await this.scans.findDocument(pageId);
    if (!found) {
      throw new DomainError(
        "PAGE_NOT_FOUND",
        "这篇笔记已经不存在。它可能已经被其他程序移动或删除。",
      );
    }
    if (isTransientVaultId(found.vaultId)) {
      throw new DomainError(
        "VAULT_READ_ONLY",
        "当前知识库处于仅预览模式，E1 不会修改这个文件夹中的任何内容。",
      );
    }

    // 乐观锁起点：文档已打开（Source Cache 有记录）用会话内版本；
    // 未打开则先读磁盘当前版本（读不写，不产生副作用）。
    const ctx = this.sources.get(pageId);
    let expectedVersionToken = ctx?.versionToken;
    if (!expectedVersionToken) {
      let current;
      try {
        current = await this.api.note.read({
          vaultId: found.vaultId,
          relativePath: found.entry.relativePath,
        });
      } catch (err) {
        throw mapReadError(err);
      }
      expectedVersionToken = current.versionToken;
    }

    let result;
    try {
      result = await this.api.note.patchMetadata({
        vaultId: found.vaultId,
        relativePath: found.entry.relativePath,
        expectedVersionToken,
        patch,
      });
    } catch (err) {
      mapNoteWriteError(err);
    }

    // Source Cache 同步：下一次正文保存序列化出新 title/tags，且以新
    // 令牌为乐观锁起点（DSK-03「同步推进该 Document Session 的
    // loaded version」）。
    if (ctx) {
      this.sources.set(pageId, {
        ...ctx,
        metadata: {
          ...ctx.metadata,
          title: patch.title !== undefined ? patch.title : ctx.metadata.title,
          tags: patch.tags !== undefined ? patch.tags : ctx.metadata.tags,
        },
        versionToken: result.versionToken,
      });
    }
    this.versions.publish(pageId, result.versionToken);
    this.scans.invalidate(found.vaultId);
  }
}

/** note.read 在元数据写入前置读取中的错误映射（与打开链路同语义）。 */
function mapReadError(err: unknown): DomainError {
  if (err instanceof DesktopIpcError && err.code === "NOTE_NOT_FOUND") {
    return new DomainError(
      "PAGE_NOT_FOUND",
      "这篇笔记已经不存在。它可能已经被其他程序移动或删除。",
    );
  }
  if (err instanceof DesktopIpcError && err.code === "VAULT_NOT_FOUND") {
    return new DomainError(
      "WORKSPACE_NOT_FOUND",
      "知识库目录不可访问，无法读取该笔记。",
    );
  }
  return err instanceof DomainError
    ? err
    : new DomainError("NOTE_IO_ERROR", "读取 Markdown 失败，未做任何修改。");
}
