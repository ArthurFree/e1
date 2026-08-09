// R006 阶段 1：预加载脚本——contextBridge 暴露完整 E1DesktopAPI。
// R006 阶段 2：vault 组扩展 open / listRecent（channel 与信封语义不变）。
// sandbox 预加载只支持 CJS（构建产物 dist-electron/preload.cjs）。
//
// 错误传递策略（与 src/platform/desktop/desktopApi.ts 注释共同锁定）：
// Main handler 永不 throw，一律返回 IpcResult 信封（{ok:true,value} |
// {ok:false,error:{code,message}}）；本层解包——ok 取 value（含 null，
// 如 selectDirectory 取消），否则拒签为带 code 的 DesktopIpcError，
// Renderer 侧以 try/catch + err.code 判断，不解析 message。
// Renderer 拿不到 ipcRenderer 本体：所有方法固定 channel 与单向 payload。
import { contextBridge, ipcRenderer } from "electron";
import {
  IPC_CHANNELS,
  type CreateNoteInput,
  type CreateNoteResult,
  type E1DesktopAPI,
  type IpcResult,
  type ImportAssetInput,
  type ImportedAsset,
  type OpenedVault,
  type OpenVaultRequest,
  type PickedFile,
  type ReadNoteInput,
  type ReadNoteResult,
  type RecentVault,
  type SaveNoteInput,
  type SaveNoteResult,
  type SelectedVault,
  type VaultScanResult,
} from "../../shared/ipc/contracts.js";
import { DesktopIpcError, isIpcErrorPayload } from "../../shared/errors.js";

async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, payload)) as IpcResult<T>;
  if (typeof result === "object" && result !== null && "ok" in result) {
    if (result.ok) return result.value;
    if (isIpcErrorPayload(result.error)) {
      throw new DesktopIpcError(result.error.code, result.error.message);
    }
  }
  throw new DesktopIpcError("INTERNAL", `IPC ${channel} 返回形状非法`);
}

const api: E1DesktopAPI = {
  platform: "desktop",
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  vault: {
    selectDirectory: () =>
      invoke<SelectedVault | null>(IPC_CHANNELS.vaultSelectDirectory),
    open: (input: OpenVaultRequest) =>
      invoke<OpenedVault>(IPC_CHANNELS.vaultOpen, input),
    listRecent: () => invoke<RecentVault[]>(IPC_CHANNELS.vaultListRecent),
    scan: (vaultId) => invoke<VaultScanResult>(IPC_CHANNELS.vaultScan, vaultId),
  },
  note: {
    read: (input: ReadNoteInput) =>
      invoke<ReadNoteResult>(IPC_CHANNELS.noteRead, input),
    create: (input: CreateNoteInput) =>
      invoke<CreateNoteResult>(IPC_CHANNELS.noteCreate, input),
    save: (input: SaveNoteInput) =>
      invoke<SaveNoteResult>(IPC_CHANNELS.noteSave, input),
  },
  asset: {
    pick: () => invoke<PickedFile | null>(IPC_CHANNELS.assetPick),
    import: (input: ImportAssetInput) =>
      invoke<ImportedAsset>(IPC_CHANNELS.assetImport, input),
    resolveUrl: (assetId) =>
      invoke<string>(IPC_CHANNELS.assetResolveUrl, assetId),
  },
};

contextBridge.exposeInMainWorld("e1", api);
