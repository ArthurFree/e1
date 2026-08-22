/**
 * R006 阶段 1：Main 侧 IPC 注册汇总。
 * main.ts 在 app.whenReady 后调用 registerIpcHandlers() 完成接线；
 * 依赖（ipcMain、原生对话框、最近 Vault 注册表）经参数注入，测试可整体 mock。
 * R006 阶段 2：registry 缺省指向 userData/recent-vaults.json（US-06）。
 * R006-C2.1：selectionTokens（目录选择授权令牌）与 transients（仅预览
 * 会话）为进程级共享单例，在此构造并注入 vault 组与 note 组 handler
 * （R006-C3-A note.read 经同一 transients 双通道解析 vaultId）。
 * R006-C5：返回 registry/transients 供 e1-asset 协议与 asset 组共用。
 * R007 阶段 3：构造 watcher 单例（SelfWriteRegistry + VaultWatcherService）
 * 注入 vault/note/asset 三组 handler——vault.scan 成功后启动监听，
 * note/asset 写成功后登记自写抑制回声；watcher 批次经 broadcastVaultEvents
 * （缺省实现遍历全部窗口 webContents.send events:vaultChanges）推给 Renderer。
 * R007 阶段 4：files 组 handler（目录/回收站/move/renameFile）共用同一
 * selfWrites——trash/restore/move/renameFile 成功后登记路径级自写抑制。
 * R007 阶段 5：secret 组（DesktopSecretPersistence，safeStorage 加密落
 * userData/secrets.json）与 reveal 组（note.reveal/asset.reveal，
 * PathGuard 后 shell.showItemInFolder）。
 * R008 Stage 1：secret 持久化迁移 electron/main/secrets/（SecretFilePersistence
 * + SecretBackendStatus——secure-persistent 才落盘，basic_text 等不安全
 * 后端只 session-only）。
 */
import { app, BrowserWindow, dialog, ipcMain, safeStorage } from "electron";
import { join } from "node:path";
import {
  IPC_CHANNELS,
  type SecretStorageStatus,
  type VaultFsEvent,
} from "../../../shared/ipc/contracts.js";
import { registerVaultHandlers } from "./vault.js";
import { registerNoteHandlers } from "./note.js";
import { registerFileHandlers } from "./files.js";
import { registerAssetHandlers } from "./asset.js";
import { registerVaultStateHandlers } from "./vaultState.js";
import { registerSecretHandlers } from "./secrets.js";
import { registerRevealHandlers } from "./reveal.js";
import { registerSearchHandlers } from "./search.js";
import { VaultRegistry } from "../vaultRegistry.js";
import { DesktopVaultStateStore } from "../state/DesktopVaultStateStore.js";
import { SecretFilePersistence } from "../secrets/SecretFilePersistence.js";
import { evaluateSecretBackendStatus } from "../secrets/SecretBackendStatus.js";
import { DesktopSearchIndexManager } from "../search/DesktopSearchDatabase.js";
import { SelectionTokenStore } from "../SelectionTokenStore.js";
import { TransientVaultStore } from "../transientVaults.js";
import {
  CapabilityTokenStore,
  type PendingFileSelection,
} from "../CapabilityTokenStore.js";
import { SelfWriteRegistry } from "../watcher/SelfWriteRegistry.js";
import { VaultWatcherService } from "../watcher/VaultWatcher.js";
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
  /** R008 Stage 1：机密持久化（缺省 userData/secrets.json + safeStorage，
   *  持久化与否由 SecretBackendStatus 模式决定）。 */
  secretStore?: SecretFilePersistence;
  /** R008 Stage 1：后端状态评估（缺省 evaluateSecretBackendStatus(safeStorage)）。 */
  secretStatus?: () => SecretStorageStatus;
  /** R008 Stage 4：全文搜索索引库集合（缺省 userData/search-index/）。 */
  searchIndexes?: DesktopSearchIndexManager;
  /** R006-C2.1：可注入以控制时钟/隔离状态（测试用）。 */
  selectionTokens?: SelectionTokenStore;
  transients?: TransientVaultStore;
  fileTokens?: CapabilityTokenStore<PendingFileSelection>;
  /** R007 阶段 3：自写注册表（缺省新建；注入可与 handler 测试共用实例）。 */
  selfWrites?: SelfWriteRegistry;
  /** R007 阶段 3：watcher 服务（缺省以 broadcastVaultEvents 为出口新建）。 */
  watchers?: VaultWatcherService;
  /** R007 阶段 3：事件广播出口（缺省遍历全部窗口推送 events:vaultChanges）。 */
  broadcastVaultEvents?: (events: VaultFsEvent[]) => void;
}

/** registerIpcHandlers 返回值：vault 根解析依赖 + R007 阶段 3 watcher 句柄。 */
export interface RegisteredIpcHandlers extends VaultRootDeps {
  watchers: VaultWatcherService;
}

/** 缺省广播：向全部窗口推送 VaultFsEvent 批次。 */
function broadcastToAllWindows(events: VaultFsEvent[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC_CHANNELS.eventsVaultChanges, events);
  }
}

export function registerIpcHandlers(
  deps: RegisterIpcHandlersDeps = {},
): RegisteredIpcHandlers {
  const bus = deps.ipc ?? ipcMain;
  const registry =
    deps.registry ??
    new VaultRegistry(join(app.getPath("userData"), "recent-vaults.json"));
  const vaultStateStore =
    deps.vaultStateStore ??
    new DesktopVaultStateStore(join(app.getPath("userData"), "vault-state"));
  const secretStatus =
    deps.secretStatus ?? (() => evaluateSecretBackendStatus(safeStorage));
  const secretStore =
    deps.secretStore ??
    new SecretFilePersistence(
      join(app.getPath("userData"), "secrets.json"),
      safeStorage,
      () => secretStatus().mode,
    );
  const searchIndexes =
    deps.searchIndexes ??
    new DesktopSearchIndexManager(
      join(app.getPath("userData"), "search-index"),
    );
  const transients = deps.transients ?? new TransientVaultStore();
  const openDialog = deps.openDialog ?? dialog;
  const selfWrites = deps.selfWrites ?? new SelfWriteRegistry();
  const watchers =
    deps.watchers ??
    new VaultWatcherService({
      onEvents: deps.broadcastVaultEvents ?? broadcastToAllWindows,
      selfWrites,
    });
  registerVaultHandlers(bus, {
    openDialog,
    registry,
    selectionTokens: deps.selectionTokens ?? new SelectionTokenStore(),
    transients,
    watchers,
  });
  registerNoteHandlers(bus, { registry, transients, selfWrites });
  registerFileHandlers(bus, { registry, transients, selfWrites });
  registerVaultStateHandlers(bus, {
    store: vaultStateStore,
    registry,
    transients,
  });
  registerSecretHandlers(bus, { store: secretStore, status: secretStatus });
  registerRevealHandlers(bus, { registry, transients });
  registerSearchHandlers(bus, { registry, transients, indexes: searchIndexes });
  registerAssetHandlers(bus, {
    openDialog: openDialog as FileDialogLike,
    registry,
    transients,
    fileTokens: deps.fileTokens ?? new CapabilityTokenStore(),
    selfWrites,
  });
  return { registry, transients, watchers };
}
