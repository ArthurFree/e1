/**
 * R006-C4-G（FR-45~52）：note.create 真实实现。
 *
 * PathGuard 创建语义 → 文件名清理/递增 → flag:"wx" exclusive create
 * → 返回 noteId / relativePath / versionToken。Transient Vault 拒写。
 */
import { randomUUID } from "node:crypto";
import { writeFile, stat } from "node:fs/promises";
import {
  IPC_CHANNELS,
  type CreateNoteResult,
  type PatchNoteMetadataResult,
  type ReadNoteResult,
  type SaveNoteResult,
} from "../../../shared/ipc/contracts.js";
import { IpcFailure } from "../../../shared/errors.js";
import {
  ensureFrontmatterId,
  generateFrontmatter,
  splitFrontmatter,
} from "../../../shared/markdown/frontmatter.js";
import {
  parseCreateNoteInput,
  parsePatchNoteMetadataInput,
  parseReadNoteInput,
  parseSaveNoteInput,
} from "../../../shared/ipc/schemas.js";
import { atomicWriteFile, classifyNoteWriteError, sha256Token } from "../filesystem/AtomicFileWriter.js";
import {
  MAX_MARKDOWN_FILE_SIZE,
  readNoteFile,
} from "../filesystem/NoteFileSystem.js";
import { patchNoteMetadataFile } from "../filesystem/NoteMetadataFileSystem.js";
import {
  resolveCreatablePathWithinVault,
  resolveWithinVault,
} from "../filesystem/PathGuard.js";
import {
  markdownFileNameForAttempt,
  sanitizeMarkdownStem,
} from "../filesystem/markdownFileName.js";
import { resolveVaultRoot, type VaultRootDeps } from "../vaultRoots.js";
import type { SelfWriteRegistry } from "../watcher/SelfWriteRegistry.js";
import { handleRequest, type IpcMainLike } from "./handler.js";

/** note 组 handler 依赖：与 vault 组共享同一 registry/transients（index.ts 注入）。 */
export interface NoteHandlerDeps extends VaultRootDeps {
  /** R007 阶段 3：写成功后登记自写，抑制 watcher 回声（reload loop 防线）。 */
  selfWrites?: SelfWriteRegistry;
}

/** 扩展名必须为 .md（大小写不敏感）。 */
const MARKDOWN_EXTENSION = /\.md$/i;

/** exclusive create 冲突递增上限（防止异常死循环）。 */
const MAX_CREATE_ATTEMPTS = 10_000;

/** 默认新建文档 Markdown（含 id/title/created/updated/tags，FR-48）。 */
function buildDefaultNewNoteMarkdown(noteId: string, title: string): string {
  const now = new Date().toISOString();
  const fm = generateFrontmatter({
    id: noteId,
    title,
    createdAt: now,
    updatedAt: now,
  });
  // generateFrontmatter 对空 tags 省略；FR-48 要求显式 tags: []——插在收尾 --- 前。
  const withTags = fm.endsWith("\n---")
    ? `${fm.slice(0, -4)}\ntags: []\n---`
    : `${fm.slice(0, -3)}tags: []\n---`;
  return `${withTags}\n\n`;
}

/**
 * 在 directory 下 exclusive create 一个新 Markdown。
 * 返回实际 relativePath 与绝对路径。
 */
async function exclusiveCreateMarkdown(input: {
  vaultRoot: string;
  directory: string;
  title: string;
  markdown: string;
}): Promise<{ relativePath: string; absolutePath: string }> {
  const stem = sanitizeMarkdownStem(input.title);
  const dirPrefix =
    input.directory.trim() === ""
      ? ""
      : input.directory.replace(/\\/g, "/").replace(/\/+$/, "") + "/";

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
    const fileName = markdownFileNameForAttempt(stem, attempt);
    const relativePath = `${dirPrefix}${fileName}`;
    const absolutePath = await resolveCreatablePathWithinVault(
      input.vaultRoot,
      relativePath,
    );
    try {
      await writeFile(absolutePath, input.markdown, {
        encoding: "utf8",
        flag: "wx",
      });
      return { relativePath, absolutePath };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EEXIST") {
        lastError = error;
        continue;
      }
      throw classifyNoteWriteError(error);
    }
  }
  throw classifyNoteWriteError(lastError ?? new Error("create attempts exhausted"));
}

export function registerNoteHandlers(
  bus: IpcMainLike,
  deps: NoteHandlerDeps = {},
): void {
  bus.handle(
    IPC_CHANNELS.noteRead,
    handleRequest(
      parseReadNoteInput,
      async (input): Promise<ReadNoteResult> => {
        const root = await resolveVaultRoot(input.vaultId, deps);
        const file = await readNoteFile({
          vaultRoot: root.absolutePath,
          relativePath: input.relativePath,
        });
        // §20.3：只解析 Frontmatter id；splitFrontmatter 要求 \n 换行，
        // 此处仅为提取 id 做临时归一，返回的 markdown 保持磁盘原文不动
        // （阅读不产生任何隐式修改，PR-02）。
        const stableNoteId =
          splitFrontmatter(file.markdown.replace(/\r\n/g, "\n")).metadata.id ??
          null;
        return {
          stableNoteId,
          relativePath: input.relativePath,
          markdown: file.markdown,
          versionToken: file.versionToken,
          source: {
            modifiedAt: file.modifiedAt,
            sizeBytes: file.sizeBytes,
          },
          hadUtf8Bom: file.hadUtf8Bom,
        };
      },
    ),
  );
  bus.handle(
    IPC_CHANNELS.noteCreate,
    handleRequest(parseCreateNoteInput, async (input): Promise<CreateNoteResult> => {
      const root = await resolveVaultRoot(input.vaultId, deps);
      if (root.transient) {
        throw new IpcFailure(
          "VAULT_READ_ONLY",
          "仅预览知识库不能创建文件。",
        );
      }

      const generatedId = randomUUID();
      const rawMarkdown =
        input.markdown ?? buildDefaultNewNoteMarkdown(generatedId, input.title);
      // INV-05：写盘前强制 Frontmatter id；response.noteId === 磁盘 id。
      const ensured = ensureFrontmatterId(rawMarkdown, generatedId);
      const bytes = Buffer.from(ensured.markdown, "utf8");
      if (bytes.byteLength > MAX_MARKDOWN_FILE_SIZE) {
        throw new IpcFailure(
          "DOCUMENT_TOO_LARGE",
          "新建 Markdown 内容过大，当前版本暂不支持（上限 10 MB）。",
          {
            sizeBytes: bytes.byteLength,
            maxBytes: MAX_MARKDOWN_FILE_SIZE,
          },
        );
      }

      const created = await exclusiveCreateMarkdown({
        vaultRoot: root.absolutePath,
        directory: input.directory,
        title: input.title,
        markdown: ensured.markdown,
      });

      const st = await stat(created.absolutePath);
      const versionToken = sha256Token(bytes);
      // R007 阶段 3：登记自写（exclusive create 落盘内容即 bytes）。
      deps.selfWrites?.record({
        vaultId: input.vaultId,
        relativePath: created.relativePath,
        versionToken,
      });
      return {
        noteId: ensured.noteId,
        relativePath: created.relativePath,
        versionToken,
        source: {
          modifiedAt: st.mtimeMs,
          sizeBytes: st.size,
        },
      };
    }),
  );
  bus.handle(
    IPC_CHANNELS.notePatchMetadata,
    handleRequest(
      parsePatchNoteMetadataInput,
      async (input): Promise<PatchNoteMetadataResult> => {
        const root = await resolveVaultRoot(input.vaultId, deps);
        // 与 note.save 同口径：Transient 仅预览 Main 层拒写。
        if (root.transient) {
          throw new IpcFailure(
            "VAULT_READ_ONLY",
            "仅预览知识库不能修改文件。",
          );
        }
        const patched = await patchNoteMetadataFile({
          vaultRoot: root.absolutePath,
          relativePath: input.relativePath,
          expectedVersionToken: input.expectedVersionToken,
          patch: input.patch,
        });
        // R007 阶段 3：登记自写，抑制 watcher 回声。
        deps.selfWrites?.record({
          vaultId: input.vaultId,
          relativePath: input.relativePath,
          versionToken: patched.versionToken,
        });
        return patched;
      },
    ),
  );
  bus.handle(
    IPC_CHANNELS.noteSave,
    handleRequest(
      parseSaveNoteInput,
      async (input): Promise<SaveNoteResult> => {
        const root = await resolveVaultRoot(input.vaultId, deps);
        // FR-15：Transient Preview Main 层拒写（不依赖 Renderer 门控）。
        if (root.transient) {
          throw new IpcFailure(
            "VAULT_READ_ONLY",
            "仅预览知识库不能修改文件。",
          );
        }
        if (!MARKDOWN_EXTENSION.test(input.relativePath)) {
          throw new IpcFailure(
            "INVALID_INPUT",
            `只支持保存 Markdown（.md）文件：${input.relativePath}`,
          );
        }
        // PathGuard 复核目标路径（SEC-02）；读取语义要求目标已存在。
        const targetPath = await resolveWithinVault(
          root.absolutePath,
          input.relativePath,
        );
        if (!MARKDOWN_EXTENSION.test(targetPath)) {
          throw new IpcFailure(
            "INVALID_INPUT",
            "符号链接目标不是 Markdown（.md）文件，已拒绝保存。",
          );
        }

        // UTF-8 编码；序列化结果同样受 10 MiB 限制（FR-16）。
        const bytes = new TextEncoder().encode(input.markdown);
        if (bytes.byteLength > MAX_MARKDOWN_FILE_SIZE) {
          throw new IpcFailure(
            "DOCUMENT_TOO_LARGE",
            "这篇 Markdown 序列化结果过大，当前版本暂不支持保存（上限 10 MB）。",
            {
              sizeBytes: bytes.byteLength,
              maxBytes: MAX_MARKDOWN_FILE_SIZE,
            },
          );
        }

        const written = await atomicWriteFile({
          targetPath,
          bytes,
          expectedVersionToken: input.expectedVersionToken,
        });
        // R007 阶段 3：登记自写（written.versionToken 为落盘后的真实 hash），
        // 抑制 watcher 回声（自动保存不触发 reload loop）。
        deps.selfWrites?.record({
          vaultId: input.vaultId,
          relativePath: input.relativePath,
          versionToken: written.versionToken,
        });
        return {
          versionToken: written.versionToken,
          source: {
            modifiedAt: written.modifiedAt,
            sizeBytes: written.sizeBytes,
          },
        };
      },
    ),
  );
}
