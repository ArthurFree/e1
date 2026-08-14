/**
 * R007 阶段 1（DSK-03）：Frontmatter 元数据局部写入。
 *
 * 流程：PathGuard → 读取当前文件（readNoteFile 全套校验）→
 * expectedVersionToken 校验 → 解析 Frontmatter → 只改 title/tags 已知键
 * （id/created/aliases/未知字段与正文逐字节保留）→ AtomicFileWriter
 * （乐观锁二次校验 + BOM 跟随 + 原子替换）→ 返回新 versionToken。
 *
 * 不做身份采纳（无 id 文档不注入 id——那是 Stable ID Adoption 的 Gate）；
 * 换行风格跟随磁盘原文（CRLF 原文写回 CRLF）；`updated` 键随写入刷新。
 */
import {
  generateFrontmatter,
  splitFrontmatter,
} from "../../../shared/markdown/frontmatter.js";
import { IpcFailure } from "../../../shared/errors.js";
import { atomicWriteFile } from "./AtomicFileWriter.js";
import { readNoteFile } from "./NoteFileSystem.js";
import { resolveWithinVault } from "./PathGuard.js";

/** 扩展名必须为 .md（大小写不敏感）。 */
const MARKDOWN_EXTENSION = /\.md$/i;

export interface PatchNoteMetadataFileInput {
  vaultRoot: string;
  relativePath: string;
  /** 乐观锁：调用方持有的最近版本令牌。 */
  expectedVersionToken: string;
  patch: {
    title?: string;
    tags?: string[];
  };
}

export interface PatchNoteMetadataFileResult {
  versionToken: string;
  /** 写后磁盘 mtime（ms 整数）。 */
  updatedAt: number;
  /** Frontmatter 稳定 id（无 id 文档为 null）。 */
  stableNoteId: string | null;
}

/**
 * 局部改写 Markdown Frontmatter 的 title/tags。
 * @throws IpcFailure DOCUMENT_CONFLICT / NOTE_NOT_FOUND / INVALID_INPUT /
 *   UNSUPPORTED_ENCODING / DOCUMENT_TOO_LARGE / NOTE_WRITE_*（沿用读取与
 *   原子写入两侧的错误分类）
 */
export async function patchNoteMetadataFile(
  input: PatchNoteMetadataFileInput,
): Promise<PatchNoteMetadataFileResult> {
  const { vaultRoot, relativePath, expectedVersionToken, patch } = input;

  // 读取当前磁盘版本（PathGuard/大小/编码校验全在 readNoteFile 内）。
  const current = await readNoteFile({ vaultRoot, relativePath });
  if (current.versionToken !== expectedVersionToken) {
    throw new IpcFailure(
      "DOCUMENT_CONFLICT",
      "这篇笔记已在 E1 之外发生修改，为避免覆盖外部修改，元数据写入已取消。",
      {
        expectedVersionToken,
        currentVersionToken: current.versionToken,
      },
    );
  }

  // splitFrontmatter 要求 \n 换行；写回时恢复原文 CRLF 风格。
  const crlf = current.markdown.includes("\r\n");
  const normalized = current.markdown.replace(/\r\n/g, "\n");
  const split = splitFrontmatter(normalized);
  const metadata = split.metadata;

  const title = patch.title !== undefined ? patch.title : metadata.title;
  const tags = patch.tags !== undefined ? patch.tags : metadata.tags;
  const frontmatter = generateFrontmatter({
    id: metadata.id,
    title,
    // tags 置空数组即删除该键（generateFrontmatter 对空列表省略）。
    tags: tags.length > 0 ? tags : undefined,
    createdAt: metadata.createdAt,
    updatedAt: new Date().toISOString(),
    aliases: metadata.aliases.length > 0 ? metadata.aliases : undefined,
    extra: metadata.extra,
  });
  const next =
    split.body.length > 0 ? `${frontmatter}\n\n${split.body}` : `${frontmatter}\n\n`;
  const output = crlf ? next.replace(/\n/g, "\r\n") : next;

  // 写入目标复查（与 note.save 同口径）：PathGuard + 真实路径 .md 复查；
  // BOM 跟随与乐观锁二次校验由 atomicWriteFile 承担。
  const targetPath = await resolveWithinVault(vaultRoot, relativePath);
  if (!MARKDOWN_EXTENSION.test(targetPath)) {
    throw new IpcFailure(
      "INVALID_INPUT",
      "符号链接目标不是 Markdown（.md）文件，已拒绝写入。",
    );
  }
  const written = await atomicWriteFile({
    targetPath,
    bytes: new TextEncoder().encode(output),
    expectedVersionToken,
  });

  return {
    versionToken: written.versionToken,
    updatedAt: written.modifiedAt,
    stableNoteId: metadata.id ?? null,
  };
}
