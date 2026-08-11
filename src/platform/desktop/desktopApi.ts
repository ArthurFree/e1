/**
 * R006 阶段 1：Renderer 侧桌面桥入口。
 *
 * window.e1 由 Electron preload（electron/preload/preload.ts）经
 * contextBridge 注入，形状为 shared/ipc/contracts 的 E1DesktopAPI。
 * Renderer 组件一律经 getDesktopApi() 获取（本文件与 main.desktop.tsx 是
 * 唯一允许出现 window.e1 / getDesktopApi 的位置，架构门禁强制）。
 *
 * 错误传递策略（与 preload 注释共同锁定）：IPC 调用失败时 Promise 拒签为
 * DesktopIpcError（带稳定 code），调用方 try/catch + err.code 判断；
 * 不采用返回值联合类型——selectDirectory/asset.pick 的「取消」已由
 * null 值表达，错误一律走异常通道。
 */
import type { E1DesktopAPI } from "../../../shared/ipc/contracts";
import { DesktopIpcError } from "../../../shared/errors";

export type {
  CreateNoteInput,
  CreateNoteResult,
  E1DesktopAPI,
  ImportAssetInput,
  ImportedAsset,
  OpenedVault,
  OpenRecentRequest,
  OpenSelectionRequest,
  PickedFile,
  ReadNoteInput,
  ReadNoteResult,
  RecentVault,
  SaveNoteInput,
  SaveNoteResult,
  SelectedVault,
  VaultScanEntry,
  VaultScanResult,
} from "../../../shared/ipc/contracts";
export { DesktopIpcError };
export type { IpcErrorCode, IpcErrorPayload } from "../../../shared/errors";

declare global {
  interface Window {
    /** Electron preload 注入的桌面桥；纯浏览器环境下不存在。 */
    e1?: E1DesktopAPI;
  }
}

/**
 * 获取桌面桥。window.e1 缺失说明当前不在 Electron 桌面运行时
 * （如纯浏览器误开 desktop.html）——显式失败并给出指引，不静默降级。
 */
export function getDesktopApi(): E1DesktopAPI {
  const api = window.e1;
  if (!api) {
    throw new Error(
      "未检测到 window.e1 桌面桥：desktop.html 只能在 Electron 桌面端运行" +
        "（npm run dev:desktop / build:desktop）；浏览器请使用 Web 入口（npm run dev）。",
    );
  }
  return api;
}
