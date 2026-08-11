/**
 * R006 阶段 1：Main 侧 IPC 注册汇总。
 * main.ts 在 app.whenReady 后调用 registerIpcHandlers() 完成接线；
 * 依赖（ipcMain、原生对话框、最近 Vault 注册表）经参数注入，测试可整体 mock。
 * R006 阶段 2：registry 缺省指向 userData/recent-vaults.json（US-06）。
 * R006-C2.1：selectionTokens（目录选择授权令牌）与 transients（仅预览
 * 会话）为进程级共享单例，在此构造并注入 vault 组与 note 组 handler
 * （R006-C3-A note.read 经同一 transients 双通道解析 vaultId）。
 */
import { app, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { registerVaultHandlers } from "./vault.js";
import { registerNoteHandlers } from "./note.js";
import { registerAssetHandlers } from "./asset.js";
import { VaultRegistry } from "../vaultRegistry.js";
import { SelectionTokenStore } from "../SelectionTokenStore.js";
import { TransientVaultStore } from "../transientVaults.js";
import type { IpcMainLike } from "./handler.js";
import type { OpenDialogLike } from "./vault.js";

export interface RegisterIpcHandlersDeps {
  ipc?: IpcMainLike;
  openDialog?: OpenDialogLike;
  registry?: VaultRegistry;
  /** R006-C2.1：可注入以控制时钟/隔离状态（测试用）。 */
  selectionTokens?: SelectionTokenStore;
  transients?: TransientVaultStore;
}

export function registerIpcHandlers(deps: RegisterIpcHandlersDeps = {}): void {
  const bus = deps.ipc ?? ipcMain;
  const registry =
    deps.registry ??
    new VaultRegistry(join(app.getPath("userData"), "recent-vaults.json"));
  const transients = deps.transients ?? new TransientVaultStore();
  registerVaultHandlers(bus, {
    openDialog: deps.openDialog ?? dialog,
    registry,
    selectionTokens: deps.selectionTokens ?? new SelectionTokenStore(),
    transients,
  });
  // R006-C3-A：note.read 经同一 registry/transients 双通道解析 vaultId。
  registerNoteHandlers(bus, { registry, transients });
  registerAssetHandlers(bus);
}
