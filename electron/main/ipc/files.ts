/**
 * R007 阶段 4（文件操作闭环）：files 组 IPC handler。
 *
 * vault.createDirectory / vault.trash / vault.listTrash / vault.restore /
 * vault.purgeTrash / note.move / note.renameFile 的统一接线：
 * schema 校验 → resolveVaultRoot → transient 拒写（listTrash 只读豁免）
 * → 文件系统层 → 自写登记（watcher 回声抑制，R007 阶段 3 口径）。
 *
 * 自写登记点（噪声分析见 r007 阶段 4 实施记录）：
 * - createDirectory：watcher 忽略 addDir，无噪声，不登记；
 * - trash：源路径产生 unlink → 登记源路径（无 token，路径+TTL 抑制）；
 * - restore：目标路径产生 add → 登记实际恢复路径（无 token）；
 * - purgeTrash：.e1/trash 被 watcher ignored，不登记；
 * - move / renameFile：unlink(old)+add(new) → 旧、新路径各登记一次。
 */
import {
  IPC_CHANNELS,
  type CreateDirectoryResult,
  type MoveNoteResult,
  type PurgeTrashResult,
  type RenameNoteFileResult,
  type RestoreTrashResult,
  type TrashListResult,
  type TrashResult,
} from "../../../shared/ipc/contracts.js";
import { IpcFailure } from "../../../shared/errors.js";
import {
  parseCreateDirectoryInput,
  parseListTrashInput,
  parseMoveNoteInput,
  parsePurgeTrashInput,
  parseRenameNoteFileInput,
  parseRestoreTrashInput,
  parseTrashInput,
} from "../../../shared/ipc/schemas.js";
import {
  createVaultDirectory,
  moveNoteFile,
  renameNoteFile,
} from "../filesystem/VaultFileOperations.js";
import {
  listTrashEntries,
  purgeTrash,
  restoreTrashEntry,
  trashEntry,
} from "../filesystem/VaultTrashFileSystem.js";
import {
  resolveVaultRoot,
  type VaultRootDeps,
  type VaultRootResolution,
} from "../vaultRoots.js";
import type { SelfWriteRegistry } from "../watcher/SelfWriteRegistry.js";
import { handleRequest, type IpcMainLike } from "./handler.js";

/** files 组 handler 依赖：与 note 组共享 registry/transients/selfWrites。 */
export interface FileHandlerDeps extends VaultRootDeps {
  selfWrites?: SelfWriteRegistry;
}

/** 写操作统一拒写 transient 仅预览会话（FR-15 口径，不依赖 Renderer 门控）。 */
function assertWritableVault(root: VaultRootResolution): void {
  if (root.transient) {
    throw new IpcFailure("VAULT_READ_ONLY", "仅预览知识库不能修改文件。");
  }
}

export function registerFileHandlers(
  bus: IpcMainLike,
  deps: FileHandlerDeps = {},
): void {
  bus.handle(
    IPC_CHANNELS.vaultCreateDirectory,
    handleRequest(
      parseCreateDirectoryInput,
      async (input): Promise<CreateDirectoryResult> => {
        const root = await resolveVaultRoot(input.vaultId, deps);
        assertWritableVault(root);
        // 建目录不产生 watcher 噪声（addDir 被忽略），无需登记自写。
        return createVaultDirectory({
          vaultRoot: root.absolutePath,
          parentRelativePath: input.parentRelativePath,
          name: input.name,
        });
      },
    ),
  );
  bus.handle(
    IPC_CHANNELS.vaultTrash,
    handleRequest(parseTrashInput, async (input): Promise<TrashResult> => {
      const root = await resolveVaultRoot(input.vaultId, deps);
      assertWritableVault(root);
      const result = await trashEntry({
        vaultRoot: root.absolutePath,
        relativePath: input.relativePath,
      });
      // 源路径 unlink 回声抑制（无 token，走路径+TTL）。
      deps.selfWrites?.record({
        vaultId: input.vaultId,
        relativePath: input.relativePath,
      });
      return result;
    }),
  );
  bus.handle(
    IPC_CHANNELS.vaultListTrash,
    handleRequest(
      parseListTrashInput,
      async (input): Promise<TrashListResult> => {
        const root = await resolveVaultRoot(input.vaultId, deps);
        // 只读操作：transient 仅预览会话允许（无 .e1/trash 时返回空表）。
        const entries = await listTrashEntries({
          vaultRoot: root.absolutePath,
        });
        return { entries };
      },
    ),
  );
  bus.handle(
    IPC_CHANNELS.vaultRestore,
    handleRequest(
      parseRestoreTrashInput,
      async (input): Promise<RestoreTrashResult> => {
        const root = await resolveVaultRoot(input.vaultId, deps);
        assertWritableVault(root);
        const result = await restoreTrashEntry({
          vaultRoot: root.absolutePath,
          operationId: input.operationId,
        });
        // 恢复 = 目标路径 add 回声抑制（无 token）。
        deps.selfWrites?.record({
          vaultId: input.vaultId,
          relativePath: result.relativePath,
        });
        return result;
      },
    ),
  );
  bus.handle(
    IPC_CHANNELS.vaultPurgeTrash,
    handleRequest(
      parsePurgeTrashInput,
      async (input): Promise<PurgeTrashResult> => {
        const root = await resolveVaultRoot(input.vaultId, deps);
        assertWritableVault(root);
        // .e1/trash 被 watcher ignored，purge 无回声，无需登记。
        return purgeTrash({
          vaultRoot: root.absolutePath,
          operationId: input.operationId,
        });
      },
    ),
  );
  bus.handle(
    IPC_CHANNELS.noteMove,
    handleRequest(
      parseMoveNoteInput,
      async (input): Promise<MoveNoteResult> => {
        const root = await resolveVaultRoot(input.vaultId, deps);
        assertWritableVault(root);
        const result = await moveNoteFile({
          vaultRoot: root.absolutePath,
          relativePath: input.relativePath,
          targetDirectory: input.targetDirectory,
        });
        // unlink(old) + add(new) 回声抑制：旧、新路径各登记一次。
        deps.selfWrites?.record({
          vaultId: input.vaultId,
          relativePath: input.relativePath,
        });
        deps.selfWrites?.record({
          vaultId: input.vaultId,
          relativePath: result.relativePath,
        });
        return result;
      },
    ),
  );
  bus.handle(
    IPC_CHANNELS.noteRenameFile,
    handleRequest(
      parseRenameNoteFileInput,
      async (input): Promise<RenameNoteFileResult> => {
        const root = await resolveVaultRoot(input.vaultId, deps);
        assertWritableVault(root);
        const result = await renameNoteFile({
          vaultRoot: root.absolutePath,
          relativePath: input.relativePath,
          newName: input.newName,
        });
        // unlink(old) + add(new) 回声抑制：旧、新路径各登记一次。
        deps.selfWrites?.record({
          vaultId: input.vaultId,
          relativePath: input.relativePath,
        });
        deps.selfWrites?.record({
          vaultId: input.vaultId,
          relativePath: result.relativePath,
        });
        return result;
      },
    ),
  );
}
