/**
 * R006 阶段 1：Main 侧 IPC 注册汇总。
 * main.ts 在 app.whenReady 后调用 registerIpcHandlers() 完成接线；
 * 依赖（ipcMain、原生对话框）经参数注入，测试可整体 mock。
 */
import { ipcMain, dialog } from "electron";
import { registerVaultHandlers } from "./vault.js";
import { registerNoteHandlers } from "./note.js";
import { registerAssetHandlers } from "./asset.js";
import type { IpcMainLike } from "./handler.js";
import type { OpenDialogLike } from "./vault.js";

export interface RegisterIpcHandlersDeps {
  ipc?: IpcMainLike;
  openDialog?: OpenDialogLike;
}

export function registerIpcHandlers(deps: RegisterIpcHandlersDeps = {}): void {
  const bus = deps.ipc ?? ipcMain;
  registerVaultHandlers(bus, deps.openDialog ?? dialog);
  registerNoteHandlers(bus);
  registerAssetHandlers(bus);
}
