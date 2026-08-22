/**
 * R008 Stage 4（§11.5）：Vault 全文索引构建管线——
 * scanVault 列出 .md → readNoteFile 读盘 → Frontmatter/纯文本提取
 * → SearchDocumentRow → 分批事务入库。
 *
 * 索引身份（note_key）：stableNoteId ?? path:<relativePath>——与
 * Renderer 侧 vaultMapping.pageIdOfEntry 同一派生规则（会话别名翻译
 * 在 Renderer 适配层，Main 不感知会话身份）。
 *
 * 读盘失败/超限的单篇不拖垮整库重建：跳过并计数（这些笔记暂时不可
 * 搜索，下次 watcher/重扫再补；R8-06 同口径——索引是派生数据）。
 */
import { markdownToPlainText } from "../../../shared/markdown/plainText.js";
import { splitFrontmatter } from "../../../shared/markdown/frontmatter.js";
import { scanVault } from "../filesystem/VaultFileSystem.js";
import { readNoteFile } from "../filesystem/NoteFileSystem.js";
import type { SearchDocumentRow } from "./DesktopSearchDatabase.js";

/** 单篇 Markdown → 索引文档；非 .md / 读盘失败返回 null（调用方跳过）。 */
export function searchDocumentFromMarkdown(input: {
  vaultId: string;
  relativePath: string;
  markdown: string;
  versionToken: string;
  modifiedAt: number;
}): SearchDocumentRow {
  const normalized = input.markdown.replace(/\r\n/g, "\n");
  const { metadata } = splitFrontmatter(normalized);
  const stableNoteId = metadata.id ?? null;
  const title =
    metadata.title ??
    input.relativePath.split("/").pop()?.replace(/\.md$/i, "") ??
    input.relativePath;
  return {
    pageId: stableNoteId ?? `path:${input.relativePath}`,
    vaultId: input.vaultId,
    stableNoteId,
    relativePath: input.relativePath,
    title,
    tags: metadata.tags,
    bodyText: markdownToPlainText(input.markdown),
    createdAt: null,
    updatedAt: input.modifiedAt,
    versionToken: input.versionToken,
  };
}

/** 扫描并流式产出整个 Vault 的索引文档（跳过非文档条目与读失败文件）。 */
export async function* iterateVaultSearchDocuments(input: {
  vaultId: string;
  vaultRoot: string;
}): AsyncIterable<SearchDocumentRow> {
  const scan = await scanVault(input.vaultRoot);
  for (const entry of scan.entries) {
    if (entry.kind !== "document") continue;
    try {
      const file = await readNoteFile({
        vaultRoot: input.vaultRoot,
        relativePath: entry.relativePath,
      });
      yield searchDocumentFromMarkdown({
        vaultId: input.vaultId,
        relativePath: entry.relativePath,
        markdown: file.markdown,
        versionToken: file.versionToken,
        modifiedAt: file.modifiedAt,
      });
    } catch {
      // 单篇读失败不阻断整库重建（派生索引，下次重扫再补）。
      console.warn(`搜索索引跳过无法读取的笔记：${entry.relativePath}`);
    }
  }
}
