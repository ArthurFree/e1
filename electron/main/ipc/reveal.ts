/**
 * R008 Stage 2（§9，R8-07）：reveal 组 IPC handler——在系统文件管理器中
 * 显示 Vault 内文件（note.reveal / asset.reveal 同一安全链路）。
 *
 * 安全链路（§9.3）：schema 校验（shared/ipc/schemas，静态拒绝绝对路径/
 * 盘符/".." 段）→ resolveVaultRoot（registry/transients 双通道授权边界）
 * → PathGuard.resolveWithinVault（realpath 根内判定，symlink 逃逸拒绝）
 * → shell.showItemInFolder(absolutePath)。absolutePath 只在 Main 内解析，
 * Renderer 永远不传（R8-07），handler 不把它回传。
 *
 * 只读操作：不修改 Vault 任何文件，transient 仅预览会话同样允许 reveal
 *（§9.5「transient Vault 行为明确」——文件真实存在于磁盘，定位不越权）。
 * 文件与目录均可 reveal（showItemInFolder 对目录选中该目录）。目标不存在
 * 归一 NOTE_NOT_FOUND（复用现有码，不为 reveal 新增 REVEAL_* 码，R007 §11
 * 原则：UI 无需新分流）。handler 永不 throw，错误经 handleRequest 归一为
 * IpcResult 信封（§15.1）。
 */
import { shell } from "electron";
import {
  IPC_CHANNELS,
  type RevealInput,
} from "../../../shared/ipc/contracts.js";
import { IpcFailure } from "../../../shared/errors.js";
import { parseRevealInput } from "../../../shared/ipc/schemas.js";
import { resolveWithinVault } from "../filesystem/PathGuard.js";
import { resolveVaultRoot, type VaultRootDeps } from "../vaultRoots.js";
import { handleRequest, type IpcMainLike } from "./handler.js";

/** electron shell 的最小结构视图（测试可注入 mock；非 Electron 环境可为 undefined）。 */
export interface ShellLike {
  showItemInFolder(fullPath: string): void;
}

export interface RevealHandlerDeps extends VaultRootDeps {
  /** 缺省取真实 electron shell；mock/缺失时注入或按不可用处理。 */
  shell?: ShellLike;
}

async function revealWithinVault(
  input: RevealInput,
  deps: RevealHandlerDeps,
): Promise<null> {
  const target = deps.shell ?? (shell as ShellLike | undefined);
  if (!target || typeof target.showItemInFolder !== "function") {
    throw new IpcFailure("INTERNAL", "当前环境不支持打开系统文件管理器。");
  }
  const root = await resolveVaultRoot(input.vaultId, deps);
  // 读取语义：目标必须存在（NOTE_NOT_FOUND）；realpath 后必须在 Vault 根内。
  const absolutePath = await resolveWithinVault(
    root.absolutePath,
    input.relativePath,
  );
  target.showItemInFolder(absolutePath);
  return null;
}

export function registerRevealHandlers(
  bus: IpcMainLike,
  deps: RevealHandlerDeps = {},
): void {
  bus.handle(
    IPC_CHANNELS.noteReveal,
    handleRequest(parseRevealInput, (input) => revealWithinVault(input, deps)),
  );
  bus.handle(
    IPC_CHANNELS.assetReveal,
    handleRequest(parseRevealInput, (input) => revealWithinVault(input, deps)),
  );
}
