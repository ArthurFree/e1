// R006 阶段 1：预加载脚本——contextBridge 暴露完整 E1DesktopAPI。
// R006 阶段 2：vault 组扩展 listRecent（channel 与信封语义不变）。
// R006-C2.1：vault.open 删除，替换为 openSelection / openRecent（FR-01/02）。
// R007 阶段 3：新增 events 组——首个 Main→Renderer 单向事件通道
// （ipcRenderer.on + 返回取消订阅函数；payload 经 schema 校验后投递）。
// R007 阶段 4：vault 组新增 createDirectory/trash/listTrash/restore/
// purgeTrash（回收站闭环），note 组新增 move/renameFile（文件操作）。
// R007 阶段 5：新增 secret 组（status/get/set/delete，safeStorage 加密
// 持久化）与 note.reveal / asset.reveal（文件管理器显示）。
// sandbox 预加载只支持 CJS（构建产物 dist-electron/preload.cjs）。
//
// 错误传递策略（与 src/platform/desktop/desktopApi.ts 注释共同锁定）：
// Main handler 永不 throw，一律返回 IpcResult 信封（{ok:true,value} |
// {ok:false,error:{code,message}}）；本层解包——ok 取 value（含 null，
// 如 selectDirectory 取消），否则拒签。注意：sandbox 下跨 contextBridge
// 的错误会被重建为 plain Error，自定义属性（code/name/details）全部丢失，
// 只有 message 存活——因此本层把载荷编码进 message（encodeIpcBridgeError），
// Renderer 侧 desktopApi 解码还原为带 code 的 DesktopIpcError 供程序判断。
// Renderer 拿不到 ipcRenderer 本体：所有方法固定 channel 与单向 payload。
import { contextBridge, ipcRenderer } from "electron";
import {
  IPC_CHANNELS,
  type AssetPickRequest,
  type AssetReadResult,
  type CreateDirectoryInput,
  type CreateDirectoryResult,
  type CreateNoteInput,
  type CreateNoteResult,
  type E1DesktopAPI,
  type IpcResult,
  type ImportAssetInput,
  type ImportedAsset,
  type ListTrashInput,
  type MoveNoteInput,
  type MoveNoteResult,
  type OpenedVault,
  type OpenRecentRequest,
  type OpenSelectionRequest,
  type PatchNoteMetadataInput,
  type PatchNoteMetadataResult,
  type PatchVaultStateInput,
  type PickedFile,
  type PurgeTrashInput,
  type PurgeTrashResult,
  type ReadAssetInput,
  type ReadNoteInput,
  type ReadNoteResult,
  type RecentVault,
  type RenameNoteFileInput,
  type RenameNoteFileResult,
  type RestoreTrashInput,
  type RestoreTrashResult,
  type RevealAssetInput,
  type RevealNoteInput,
  type SaveNoteInput,
  type SaveNoteResult,
  type SearchIndexStatus,
  type SearchQueryInput,
  type SearchQueryRow,
  type SearchRebuildInput,
  type SearchRebuildResult,
  type SearchRelocateInput,
  type SearchRemoveInput,
  type SearchStatusInput,
  type SearchUpsertInput,
  type SearchUpsertResult,
  type SecretSetInput,
  type SecretStorageStatus,
  type SelectedVault,
  type TrashInput,
  type TrashListResult,
  type TrashResult,
  type VaultScanResult,
  type VaultFsEvent,
  type VaultState,
} from "../../shared/ipc/contracts.js";
import {
  encodeIpcBridgeError,
  isIpcErrorPayload,
} from "../../shared/errors.js";
import { parseVaultFsEvents } from "../../shared/ipc/schemas.js";

async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, payload)) as IpcResult<T>;
  if (typeof result === "object" && result !== null && "ok" in result) {
    if (result.ok) return result.value;
    if (isIpcErrorPayload(result.error)) {
      // 跨 contextBridge 只有 message 存活，载荷编码进 message（见文件头注释）。
      throw encodeIpcBridgeError(result.error);
    }
  }
  throw encodeIpcBridgeError({
    code: "INTERNAL",
    message: `IPC ${channel} 返回形状非法`,
  });
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
    openSelection: (input: OpenSelectionRequest) =>
      invoke<OpenedVault>(IPC_CHANNELS.vaultOpenSelection, input),
    openRecent: (input: OpenRecentRequest) =>
      invoke<OpenedVault>(IPC_CHANNELS.vaultOpenRecent, input),
    listRecent: () => invoke<RecentVault[]>(IPC_CHANNELS.vaultListRecent),
    scan: (vaultId) => invoke<VaultScanResult>(IPC_CHANNELS.vaultScan, vaultId),
    createDirectory: (input: CreateDirectoryInput) =>
      invoke<CreateDirectoryResult>(IPC_CHANNELS.vaultCreateDirectory, input),
    trash: (input: TrashInput) =>
      invoke<TrashResult>(IPC_CHANNELS.vaultTrash, input),
    listTrash: (input: ListTrashInput) =>
      invoke<TrashListResult>(IPC_CHANNELS.vaultListTrash, input),
    restore: (input: RestoreTrashInput) =>
      invoke<RestoreTrashResult>(IPC_CHANNELS.vaultRestore, input),
    purgeTrash: (input: PurgeTrashInput) =>
      invoke<PurgeTrashResult>(IPC_CHANNELS.vaultPurgeTrash, input),
  },
  vaultState: {
    get: (vaultId) => invoke<VaultState>(IPC_CHANNELS.vaultStateGet, vaultId),
    patch: (input: PatchVaultStateInput) =>
      invoke<VaultState>(IPC_CHANNELS.vaultStatePatch, input),
  },
  note: {
    read: (input: ReadNoteInput) =>
      invoke<ReadNoteResult>(IPC_CHANNELS.noteRead, input),
    create: (input: CreateNoteInput) =>
      invoke<CreateNoteResult>(IPC_CHANNELS.noteCreate, input),
    save: (input: SaveNoteInput) =>
      invoke<SaveNoteResult>(IPC_CHANNELS.noteSave, input),
    patchMetadata: (input: PatchNoteMetadataInput) =>
      invoke<PatchNoteMetadataResult>(IPC_CHANNELS.notePatchMetadata, input),
    move: (input: MoveNoteInput) =>
      invoke<MoveNoteResult>(IPC_CHANNELS.noteMove, input),
    renameFile: (input: RenameNoteFileInput) =>
      invoke<RenameNoteFileResult>(IPC_CHANNELS.noteRenameFile, input),
    reveal: (input: RevealNoteInput) =>
      invoke<void>(IPC_CHANNELS.noteReveal, input),
  },
  secret: {
    status: () => invoke<SecretStorageStatus>(IPC_CHANNELS.secretStatus),
    get: (name: string) => invoke<string | null>(IPC_CHANNELS.secretGet, name),
    set: (input: SecretSetInput) => invoke<void>(IPC_CHANNELS.secretSet, input),
    remove: (name: string) => invoke<void>(IPC_CHANNELS.secretDelete, name),
  },
  search: {
    query: (input: SearchQueryInput) =>
      invoke<SearchQueryRow[]>(IPC_CHANNELS.searchQuery, input),
    rebuild: (input: SearchRebuildInput) =>
      invoke<SearchRebuildResult>(IPC_CHANNELS.searchRebuild, input),
    upsert: (input: SearchUpsertInput) =>
      invoke<SearchUpsertResult>(IPC_CHANNELS.searchUpsert, input),
    remove: (input: SearchRemoveInput) =>
      invoke<void>(IPC_CHANNELS.searchRemove, input),
    relocate: (input: SearchRelocateInput) =>
      invoke<void>(IPC_CHANNELS.searchRelocate, input),
    status: (input: SearchStatusInput) =>
      invoke<SearchIndexStatus>(IPC_CHANNELS.searchStatus, input),
  },
  asset: {
    pick: (input?: AssetPickRequest) =>
      invoke<PickedFile | null>(IPC_CHANNELS.assetPick, input),
    import: (input: ImportAssetInput) =>
      invoke<ImportedAsset>(IPC_CHANNELS.assetImport, input),
    read: (input: ReadAssetInput) =>
      invoke<AssetReadResult>(IPC_CHANNELS.assetRead, input),
    resolveUrl: (assetId) =>
      invoke<string>(IPC_CHANNELS.assetResolveUrl, assetId),
    reveal: (input: RevealAssetInput) =>
      invoke<void>(IPC_CHANNELS.assetReveal, input),
  },
  events: {
    subscribeVaultChanges: (listener: (events: VaultFsEvent[]) => void) => {
      const wrapped = (_event: unknown, payload: unknown) => {
        try {
          listener(parseVaultFsEvents(payload));
        } catch {
          // 形状非法的推送直接丢弃：事件通道是单向事实流，
          // 无法向 Main 回报错误，也不应打断 Renderer。
        }
      };
      ipcRenderer.on(IPC_CHANNELS.eventsVaultChanges, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.eventsVaultChanges, wrapped);
      };
    },
  },
};

contextBridge.exposeInMainWorld("e1", api);
