/**
 * R007 阶段 5（§5.2）：note.reveal / asset.reveal——在系统文件管理器中
 * 显示笔记/分组/附件（shell.showItemInFolder）。
 *
 * 授权边界（DSK-02）：Renderer 只传 vaultId + relativePath / assetId，
 * Main 侧 resolveVaultRoot + PathGuard（resolveWithinVault 含 realpath
 * 符号链接逃逸防护）后才触碰绝对路径；Renderer 全程不见 absolutePath。
 * 只读操作：transient 仅预览会话同样允许（与 note.read 同口径）。
 * R009 Stage 0.2（§3.3）：createRecordingShell——E2E 记录型 stub。
 * Linux CI（xvfb headless）没有文件管理器，真实 shell.showItemInFolder
 * 会挂起导致超时；E1_REVEAL_STUB=1 时 Main 改用它，把解析后的绝对路径
 * 逐行追加到日志文件，E2E 据此断言「UI → preload → IPC → Main handler
 * → PathGuard」全链路，真实 OS 集成仅 macOS/Windows 手动验收。
 */
import { appendFileSync } from "node:fs";
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

/**
 * R009 Stage 0.2（§3.3）：E2E 记录型 shell——不调真实 OS shell，
 * 把每次 showItemInFolder 收到的绝对路径逐行追加到日志文件。
 * 仅 main.ts 在 E1_REVEAL_STUB=1（桌面 E2E）时注入，生产/开发不启用。
 */
export function createRecordingShell(logPath: string): ShellLike {
  return {
    showItemInFolder(fullPath: string): void {
      appendFileSync(logPath, `${fullPath}\n`, "utf8");
    },
  };
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
