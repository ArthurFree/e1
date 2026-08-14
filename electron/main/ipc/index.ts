/**
 * R006 阶段 1：Main 侧 IPC 注册汇总。
 * main.ts 在 app.whenReady 后调用 registerIpcHandlers() 完成接线；
 * 依赖（ipcMain、原生对话框、最近 Vault 注册表）经参数注入，测试可整体 mock。
 * R006 阶段 2：registry 缺省指向 userData/recent-vaults.json（US-06）。
 * R006-C2.1：selectionTokens（目录选择授权令牌）与 transients（仅预览
 * 会话）为进程级共享单例，在此构造并注入 vault 组与 note 组 handler
 * （R006-C3-A note.read 经同一 transients 双通道解析 vaultId）。
 * R006-C5：返回 registry/transients 供 e1-asset 协议与 asset 组共用。
 */
import { app, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { registerVaultHandlers } from "./vault.js";
import { registerNoteHandlers } from "./note.js";
import { registerAssetHandlers } from "./asset.js";
import { registerVaultStateHandlers } from "./vaultState.js";
import { VaultRegistry } from "../vaultRegistry.js";
import { DesktopVaultStateStore } from "../state/DesktopVaultStateStore.js";
import { SelectionTokenStore } from "../SelectionTokenStore.js";
import { TransientVaultStore } from "../transientVaults.js";
import {
  CapabilityTokenStore,
  type PendingFileSelection,
} from "../CapabilityTokenStore.js";
import type { IpcMainLike } from "./handler.js";
import type { OpenDialogLike } from "./vault.js";
import type { FileDialogLike } from "./asset.js";
import type { VaultRootDeps } from "../vaultRoots.js";

export interface RegisterIpcHandlersDeps {
  ipc?: IpcMainLike;
  openDialog?: OpenDialogLike;
  registry?: VaultRegistry;
  /** R007 阶段 2：设备级交互状态存储（缺省指向 userData/vault-state/）。 */
  vaultStateStore?: DesktopVaultStateStore;
  /** R006-C2.1：可注入以控制时钟/隔离状态（测试用）。 */
  selectionTokens?: SelectionTokenStore;
  transients?: TransientVaultStore;
  fileTokens?: CapabilityTokenStore<PendingFileSelection>;
}

export function registerIpcHandlers(
  deps: RegisterIpcHandlersDeps = {},
): VaultRootDeps {
  const bus = deps.ipc ?? ipcMain;
  const registry =
    deps.registry ??
    new VaultRegistry(join(app.getPath("userData"), "recent-vaults.json"));
  const vaultStateStore =
    deps.vaultStateStore ??
    new DesktopVaultStateStore(join(app.getPath("userData"), "vault-state"));
  const transients = deps.transients ?? new TransientVaultStore();
  const openDialog = deps.openDialog ?? dialog;
  registerVaultHandlers(bus, {
    openDialog,
    registry,
    selectionTokens: deps.selectionTokens ?? new SelectionTokenStore(),
    transients,
  });
  registerNoteHandlers(bus, { registry, transients });
  registerVaultStateHandlers(bus, {
    store: vaultStateStore,
    registry,
    transients,
  });
  registerAssetHandlers(bus, {
    openDialog: openDialog as FileDialogLike,
    registry,
    transients,
    fileTokens: deps.fileTokens ?? new CapabilityTokenStore(),
  });
  return { registry, transients };
}
