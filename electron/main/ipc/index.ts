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
 * R010 Stage 3：search/link 两组共用 DesktopVaultIndexManager（per-vault
 * 单连接共库，§17 实施决策），新增 link 组 handler。
 * R009 Stage 0.2（§3.3）：reveal 组支持注入 shell（E1_REVEAL_STUB=1 的
 * 桌面 E2E 用记录型 stub，见 main.ts）。
 * R009 Stage 6（Auto Update）：update 组——DesktopUpdateService 封装
 * electron-updater（GitHub Releases feed），autoUpdater 实例由 main.ts
 * 注入（electron-updater 为 CJS 懒加载 getter，main.ts 是唯一入口），
 * 状态变化经 broadcastUpdateStatus 推送 events:updateStatus。
 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  shell,
} from "electron";
import { join } from "node:path";
import {
  IPC_CHANNELS,
  type SecretStorageStatus,
  type UpdateStatus,
  type VaultFsEvent,
} from "../../../shared/ipc/contracts.js";
import { registerVaultHandlers } from "./vault.js";
import { registerNoteHandlers } from "./note.js";
import { registerFileHandlers } from "./files.js";
import { registerAssetHandlers } from "./asset.js";
import { registerVaultStateHandlers } from "./vaultState.js";
import { registerSecretHandlers } from "./secrets.js";
import { registerRevealHandlers, type ShellLike } from "./reveal.js";
import { registerSearchHandlers } from "./search.js";
import { registerLinkHandlers } from "./links.js";
import { VaultRegistry } from "../vaultRegistry.js";
import { DesktopVaultStateStore } from "../state/DesktopVaultStateStore.js";
import { SecretFilePersistence } from "../secrets/SecretFilePersistence.js";
import { evaluateSecretBackendStatus } from "../secrets/SecretBackendStatus.js";
import { DesktopVaultIndexManager } from "../index/DesktopVaultIndexManager.js";
import { SelectionTokenStore } from "../SelectionTokenStore.js";
import { TransientVaultStore } from "../transientVaults.js";
import {
  CapabilityTokenStore,
  type PendingFileSelection,
} from "../CapabilityTokenStore.js";
import { SelfWriteRegistry } from "../watcher/SelfWriteRegistry.js";
import { VaultWatcherService } from "../watcher/VaultWatcher.js";
import {
  DesktopUpdateService,
  type AutoUpdaterLike,
} from "../update/DesktopUpdateService.js";
import { registerUpdateHandlers } from "./update.js";
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
  /**
   * R008 Stage 4 + R010 Stage 3：per-vault 索引库集合（Search + Link
   * 共库单连接；缺省 userData/search-index/）。
   */
  indexes?: DesktopVaultIndexManager;
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
  /** R009 Stage 0.2：reveal 组的 shell（缺省真实 electron shell；
   *  桌面 E2E 经 E1_REVEAL_STUB=1 注入记录型 stub，见 main.ts）。 */
  shell?: ShellLike;
  /** R009 Stage 6：electron-updater 实例（仅 main.ts 注入真实实现；
   *  缺省/未打包时 update 组报 unsupported，不触网）。 */
  updateAutoUpdater?: AutoUpdaterLike;
  /** R009 Stage 6：更新状态推送出口（缺省遍历全部窗口广播）。 */
  broadcastUpdateStatus?: (status: UpdateStatus) => void;
  /** R009 Stage 6：打开外部链接（缺省 shell.openExternal）。 */
  openExternal?: (url: string) => Promise<void>;
  /** R009 Stage 6：E1_UPDATE_FEED_URL 手动 QA 覆盖（main.ts 注入）。 */
  updateFeedUrlOverride?: string;
}

/** registerIpcHandlers 返回值：vault 根解析依赖 + watcher / update 句柄。 */
export interface RegisteredIpcHandlers extends VaultRootDeps {
  watchers: VaultWatcherService;
  /** R009 Stage 6：更新服务句柄（main.ts 用于启动后自动检查）。 */
  update: DesktopUpdateService;
}

/** 缺省广播：向全部窗口推送 VaultFsEvent 批次。 */
function broadcastToAllWindows(events: VaultFsEvent[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC_CHANNELS.eventsVaultChanges, events);
  }
}

/** R009 Stage 6：缺省广播——向全部窗口推送更新状态。 */
function broadcastUpdateStatusToAllWindows(status: UpdateStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC_CHANNELS.eventsUpdateStatus, status);
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
  const indexes =
    deps.indexes ??
    new DesktopVaultIndexManager(join(app.getPath("userData"), "search-index"));
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
  registerRevealHandlers(bus, { registry, transients, shell: deps.shell });
  registerSearchHandlers(bus, { registry, transients, indexes });
  registerLinkHandlers(bus, { registry, transients, indexes });
  registerAssetHandlers(bus, {
    openDialog: openDialog as FileDialogLike,
    registry,
    transients,
    fileTokens: deps.fileTokens ?? new CapabilityTokenStore(),
    selfWrites,
  });
  const update = new DesktopUpdateService({
    autoUpdater: deps.updateAutoUpdater,
    platform: process.platform,
    // 未注入 autoUpdater（测试/异常装配）视同未打包：update 组报 unsupported。
    isPackaged: app.isPackaged && deps.updateAutoUpdater !== undefined,
    currentVersion: app.getVersion(),
    emit: deps.broadcastUpdateStatus ?? broadcastUpdateStatusToAllWindows,
    openExternal: deps.openExternal ?? ((url) => shell.openExternal(url)),
    feedUrlOverride: deps.updateFeedUrlOverride,
  });
  registerUpdateHandlers(bus, { service: update });
  return { registry, transients, watchers, update };
}
