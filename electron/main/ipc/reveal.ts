/**
 * R007 阶段 5（§5.2）：note.reveal / asset.reveal——在系统文件管理器中
 * 显示笔记/分组/附件（shell.showItemInFolder）。
 *
 * 授权边界（DSK-02）：Renderer 只传 vaultId + relativePath / assetId，
 * Main 侧 resolveVaultRoot + PathGuard（resolveWithinVault 含 realpath
 * 符号链接逃逸防护）后才触碰绝对路径；Renderer 全程不见 absolutePath。
 * 只读操作：transient 仅预览会话同样允许（与 note.read 同口径）。
 */
import { shell } from "electron";
import { IPC_CHANNELS } from "../../../shared/ipc/contracts.js";
import { IpcFailure } from "../../../shared/errors.js";
import { decodeDesktopAssetId } from "../../../shared/assets/desktopAssetId.js";
import {
  parseRevealAssetInput,
  parseRevealNoteInput,
} from "../../../shared/ipc/schemas.js";
import { resolveWithinVault } from "../filesystem/PathGuard.js";
import { resolveVaultRoot, type VaultRootDeps } from "../vaultRoots.js";
import { handleRequest, type IpcMainLike } from "./handler.js";

/** Electron shell 的最小结构视图（测试可注入 mock）。 */
export interface ShellLike {
  showItemInFolder(fullPath: string): void;
}

export interface RevealHandlerDeps extends VaultRootDeps {
  shell?: ShellLike;
}

/** PathGuard 的「目标不存在」归一为 reveal 专属错误码（§11）。 */
async function resolveRevealTarget(
  vaultRoot: string,
  relativePath: string,
): Promise<string> {
  try {
    return await resolveWithinVault(vaultRoot, relativePath);
  } catch (error) {
    if (error instanceof IpcFailure && error.code === "NOTE_NOT_FOUND") {
      throw new IpcFailure(
        "REVEAL_TARGET_NOT_FOUND",
        `目标不存在，无法在文件管理器中显示：${relativePath}`,
      );
    }
    throw error;
  }
}

export function registerRevealHandlers(
  bus: IpcMainLike,
  deps: RevealHandlerDeps = {},
): void {
  const shellLike = deps.shell ?? shell;

  bus.handle(
    IPC_CHANNELS.noteReveal,
    handleRequest(parseRevealNoteInput, async (input): Promise<void> => {
      const root = await resolveVaultRoot(input.vaultId, deps);
      const target = await resolveRevealTarget(
        root.absolutePath,
        input.relativePath,
      );
      shellLike.showItemInFolder(target);
    }),
  );

  bus.handle(
    IPC_CHANNELS.assetReveal,
    handleRequest(parseRevealAssetInput, async (input): Promise<void> => {
      const decoded = decodeDesktopAssetId(input.assetId);
      if (!decoded) {
        throw new IpcFailure("INVALID_INPUT", "资源身份无效。");
      }
      const root = await resolveVaultRoot(decoded.vaultId, deps);
      const target = await resolveRevealTarget(
        root.absolutePath,
        decoded.relativePath,
      );
      shellLike.showItemInFolder(target);
    }),
  );
}
