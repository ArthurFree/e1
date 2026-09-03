/**
 * R010 Stage 3（§11）：Vault 链接索引构建管线——
 * scanVault 列出 .md → readNoteFile 读盘 → extractMarkdownLinks 提取
 * → LinkIndexDocument → DesktopLinkDatabase 入库（目标解析由 DB 按
 * link_docs 快照完成，broken/恢复是重解析的副产品）。
 *
 * 索引身份（noteKey）：stableNoteId ?? "path:<relativePath>"——与搜索
 * 索引 note_key / Renderer 侧 vaultMapping.pageIdOfEntry 同一派生规则。
 *
 * 读盘失败/超限的单篇不拖垮整库重建：跳过并计数（与搜索索引同口径——
 * 索引是派生数据，下次 watcher/重扫再补）。
 */
import { splitFrontmatter } from "../../../shared/markdown/frontmatter.js";
import { extractMarkdownLinks } from "../../../shared/links/extractMarkdownLinks.js";
import type { LinkIndexDocument } from "../../../shared/links/LinkIndex.js";
import { scanVault } from "../filesystem/VaultFileSystem.js";
import { readNoteFile } from "../filesystem/NoteFileSystem.js";

/** 单篇 Markdown → 链接索引文档（Frontmatter 身份/标题 + 链接提取）。 */
export function linkDocumentFromMarkdown(input: {
  vaultId: string;
  relativePath: string;
  markdown: string;
  versionToken: string;
}): LinkIndexDocument {
  const normalized = input.markdown.replace(/\r\n/g, "\n");
  const { metadata } = splitFrontmatter(normalized);
  const stableNoteId = metadata.id ?? null;
  const title =
    metadata.title ??
    input.relativePath.split("/").pop()?.replace(/\.md$/i, "") ??
    input.relativePath;
  return {
    noteKey: stableNoteId ?? `path:${input.relativePath}`,
    vaultId: input.vaultId,
    stableNoteId,
    relativePath: input.relativePath,
    title,
    versionToken: input.versionToken,
    links: extractMarkdownLinks(normalized, input.relativePath),
  };
}

/** 扫描并流式产出整个 Vault 的链接索引文档（跳过非文档条目与读失败文件）。 */
export async function* iterateVaultLinkDocuments(input: {
  vaultId: string;
  vaultRoot: string;
}): AsyncIterable<LinkIndexDocument> {
  const scan = await scanVault(input.vaultRoot);
  for (const entry of scan.entries) {
    if (entry.kind !== "document") continue;
    try {
      const file = await readNoteFile({
        vaultRoot: input.vaultRoot,
        relativePath: entry.relativePath,
      });
      yield linkDocumentFromMarkdown({
        vaultId: input.vaultId,
        relativePath: entry.relativePath,
        markdown: file.markdown,
        versionToken: file.versionToken,
      });
    } catch {
      // 单篇读失败不阻断整库重建（派生索引，下次重扫再补）。
      console.warn(`链接索引跳过无法读取的笔记：${entry.relativePath}`);
    }
  }
}
