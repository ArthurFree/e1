/**
 * R008 Stage 4（§11.5）：Vault 正文真相 → SearchDocument 的来源实现。
 *
 * rebuild/首建时经授权边界（resolveVaultRoot：注册表/transient 双通道）
 * 解析 Vault 根 → scanVault 全量扫描 → 逐篇 readNoteFile（PathGuard
 * 复核）→ splitFrontmatter 取元数据 + markdownToSearchText 提取可检索
 * 纯文本（与 Renderer 共用 shared/ 同一实现）。只读：不修改 Vault 任何
 * 文件（transient 仅预览会话同样允许建索引——索引存 userData）。
 *
 * pageId 口径与 Renderer 会话身份一致（PR-03）：Frontmatter stable note
 * id 优先，缺失为 "path:<relativePath>"——搜索结果据此直接跳转页面树。
 *
 * 单篇读取失败（权限/IO/超大小上限）跳过该篇、不阻断整体重建——该文档
 * 在下一次增量或重建时重试（§20：搜索失败永远让位于正文可用性）。
 */
import { splitFrontmatter } from "../../../shared/markdown/frontmatter.js";
import { markdownToSearchText } from "../../../shared/markdown/searchText.js";
import type { SearchDocument } from "../../../shared/search/model.js";
import { scanVault } from "../filesystem/VaultFileSystem.js";
import { readNoteFile } from "../filesystem/NoteFileSystem.js";
import { resolveVaultRoot, type VaultRootDeps } from "../vaultRoots.js";
import type { SearchDocumentSource } from "./DesktopSearchService.js";

export class VaultSearchDocumentSource implements SearchDocumentSource {
  constructor(private readonly deps: VaultRootDeps) {}

  async load(vaultId: string): Promise<SearchDocument[]> {
    const root = await resolveVaultRoot(vaultId, this.deps);
    const scan = await scanVault(root.absolutePath);
    const documents: SearchDocument[] = [];
    for (const entry of scan.entries) {
      if (entry.kind !== "document") continue;
      try {
        const note = await readNoteFile({
          vaultRoot: root.absolutePath,
          relativePath: entry.relativePath,
        });
        const split = splitFrontmatter(note.markdown.replace(/\r\n/g, "\n"));
        documents.push({
          pageId: entry.noteId ?? `path:${entry.relativePath}`,
          vaultId,
          stableNoteId: entry.noteId,
          relativePath: entry.relativePath,
          title: entry.title,
          tags: entry.tags,
          bodyText: markdownToSearchText(note.markdown),
          createdAt: parseFrontmatterTimestamp(split.metadata.createdAt),
          updatedAt: parseFrontmatterTimestamp(split.metadata.updatedAt),
          versionToken: note.versionToken,
        });
      } catch {
        // 单篇失败跳过（见文件头注释），不影响其余文档进入索引。
      }
    }
    return documents;
  }
}

/** Frontmatter created/updated（ISO 字符串）→ ms；缺失/非法为 null。 */
function parseFrontmatterTimestamp(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}
