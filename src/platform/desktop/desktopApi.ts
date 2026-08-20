/**
 * R006 阶段 1：Renderer 侧桌面桥入口。
 *
 * window.e1 由 Electron preload（electron/preload/preload.ts）经
 * contextBridge 注入，形状为 shared/ipc/contracts 的 E1DesktopAPI。
 * Renderer 组件一律经 getDesktopApi() 获取（本文件与 main.desktop.tsx 是
 * 唯一允许出现 window.e1 / getDesktopApi 的位置，架构门禁强制）。
 *
 * 错误传递策略（与 preload 注释共同锁定）：sandbox 下跨 contextBridge
 * 的拒签错误会被重建为 plain Error，自定义属性全部丢失，preload 因此把
 * {code,message,details} 编码进 message（shared/errors 的
 * encodeIpcBridgeError）。本层在 getDesktopApi() 返回的桥上统一解码，
 * 重新拒签为带稳定 code 的 DesktopIpcError——调用方 try/catch + err.code
 * 判断；不采用返回值联合类型——selectDirectory/asset.pick 的「取消」已由
 * null 值表达，错误一律走异常通道。
 */
import type { E1DesktopAPI } from "../../../shared/ipc/contracts";
import {
  DesktopIpcError,
  decodeIpcBridgeError,
} from "../../../shared/errors";

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
 * 解码跨桥错误并重抛：桥编码载荷 → DesktopIpcError（还原 code/details）；
 * 非桥编码错误（本地异常、Cancelled 等）原样抛出。
 */
function rethrowDecoded(error: unknown): never {
  const payload = decodeIpcBridgeError(error);
  if (payload) {
    throw new DesktopIpcError(payload.code, payload.message, payload.details);
  }
  throw error;
}

/**
 * 递归包装桥对象：所有返回 Promise 的方法统一接 decode 重抛；
 * 同步返回（如 events.subscribeVaultChanges 的取消订阅函数）原样透传。
 * 包装只在 getDesktopApi 边界做一次并缓存，组件拿到的就是解码后的桥。
 */
function wrapBridgeErrors<T>(value: T): T {
  if (typeof value === "function") {
    const fn = value as unknown as (...args: unknown[]) => unknown;
    return ((...args: unknown[]) => {
      const result = fn(...args);
      if (
        result !== null &&
        (typeof result === "object" || typeof result === "function") &&
        typeof (result as { then?: unknown }).then === "function"
      ) {
        return (result as Promise<unknown>).catch(rethrowDecoded);
      }
      return result;
    }) as unknown as T;
  }
  if (typeof value === "object" && value !== null) {
    const wrapped: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      wrapped[key] = wrapBridgeErrors(child);
    }
    return wrapped as T;
  }
  return value;
}

let cachedApi: E1DesktopAPI | null = null;

/**
 * 获取桌面桥。window.e1 缺失说明当前不在 Electron 桌面运行时
 * （如纯浏览器误开 desktop.html）——显式失败并给出指引，不静默降级。
 */
export function getDesktopApi(): E1DesktopAPI {
  if (cachedApi) return cachedApi;
  const api = window.e1;
  if (!api) {
    throw new Error(
      "未检测到 window.e1 桌面桥：desktop.html 只能在 Electron 桌面端运行" +
        "（npm run dev:desktop / build:desktop）；浏览器请使用 Web 入口（npm run dev）。",
    );
  }
  cachedApi = wrapBridgeErrors(api);
  return cachedApi;
}
