/**
 * R006 阶段 1：asset 组 IPC handler。
 * 本阶段全部为契约桩（NOT_IMPLEMENTED）——原生文件选择、assets/ 目录
 * 复制与安全 URL 解析属阶段 5（r006 §13）。
 */
import { IPC_CHANNELS } from "../../../shared/ipc/contracts.js";
import { IpcFailure } from "../../../shared/errors.js";
import {
  parseImportAssetInput,
  parseNoInput,
  parseResolveAssetUrlInput,
} from "../../../shared/ipc/schemas.js";
import { handleRequest, type IpcMainLike } from "./handler.js";

function notImplemented(channel: string): never {
  throw new IpcFailure("NOT_IMPLEMENTED", `${channel} 将在 R006 阶段 5 实现`);
}

export function registerAssetHandlers(bus: IpcMainLike): void {
  bus.handle(
    IPC_CHANNELS.assetPick,
    handleRequest(parseNoInput, () => notImplemented("asset.pick")),
  );
  bus.handle(
    IPC_CHANNELS.assetImport,
    handleRequest(parseImportAssetInput, () => notImplemented("asset.import")),
  );
  bus.handle(
    IPC_CHANNELS.assetResolveUrl,
    handleRequest(parseResolveAssetUrlInput, () =>
      notImplemented("asset.resolveUrl"),
    ),
  );
}
