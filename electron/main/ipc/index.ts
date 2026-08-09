/**
 * R006 阶段 1：Main 侧 IPC 注册汇总。
 * main.ts 在 app.whenReady 后调用 registerIpcHandlers() 完成接线；
 * 依赖（ipcMain、原生对话框、最近 Vault 注册表）经参数注入，测试可整体 mock。
 * R006 阶段 2：registry 缺省指向 userData/recent-vaults.json（US-06）。
 */
import { app, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { registerVaultHandlers } from "./vault.js";
import { registerNoteHandlers } from "./note.js";
import { registerAssetHandlers } from "./asset.js";
import { VaultRegistry } from "../vaultRegistry.js";
import type { IpcMainLike } from "./handler.js";
import type { OpenDialogLike } from "./vault.js";

export interface RegisterIpcHandlersDeps {
  ipc?: IpcMainLike;
  openDialog?: OpenDialogLike;
  registry?: VaultRegistry;
}

export function registerIpcHandlers(deps: RegisterIpcHandlersDeps = {}): void {
  const bus = deps.ipc ?? ipcMain;
  const registry =
    deps.registry ??
    new VaultRegistry(join(app.getPath("userData"), "recent-vaults.json"));
  registerVaultHandlers(bus, {
    openDialog: deps.openDialog ?? dialog,
    registry,
  });
  registerNoteHandlers(bus);
  registerAssetHandlers(bus);
}
