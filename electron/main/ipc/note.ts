/**
 * R006 阶段 1：note 组 IPC handler（契约桩）。
 * R006-C3-A（FR-12，r006-c3 §20）：note.read 落地真实实现——
 * resolveVaultRoot 双通道解析 vaultId（注册表 / transient 仅预览会话）
 * → NoteFileSystem.readNoteFile（PathGuard + 大小/编码/SHA256）
 * → shared/markdown/frontmatter 纯字符串解析 Frontmatter id 作为
 * stableNoteId（缺失为 null，Main 不创建 id，PR-03/FR-16：Main 只经
 * shared/ 读 Frontmatter，不 import Tiptap 或 src/editor）。
 * note.create / note.save 仍为 NOT_IMPLEMENTED 契约桩（属 C4）。
 */
import {
  IPC_CHANNELS,
  type ReadNoteResult,
} from "../../../shared/ipc/contracts.js";
import { IpcFailure } from "../../../shared/errors.js";
import { splitFrontmatter } from "../../../shared/markdown/frontmatter.js";
import {
  parseCreateNoteInput,
  parseReadNoteInput,
  parseSaveNoteInput,
} from "../../../shared/ipc/schemas.js";
import { readNoteFile } from "../filesystem/NoteFileSystem.js";
import { resolveVaultRoot, type VaultRootDeps } from "../vaultRoots.js";
import { handleRequest, type IpcMainLike } from "./handler.js";

/** note 组 handler 依赖：与 vault 组共享同一 registry/transients（index.ts 注入）。 */
export type NoteHandlerDeps = VaultRootDeps;

function notImplemented(channel: string): never {
  throw new IpcFailure(
    "NOT_IMPLEMENTED",
    `${channel} 将在 R006-C4（Markdown 创建与安全保存）实现`,
  );
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
        };
      },
    ),
  );
  bus.handle(
    IPC_CHANNELS.noteCreate,
    handleRequest(parseCreateNoteInput, () => notImplemented("note.create")),
  );
  bus.handle(
    IPC_CHANNELS.noteSave,
    handleRequest(parseSaveNoteInput, () => notImplemented("note.save")),
  );
}
