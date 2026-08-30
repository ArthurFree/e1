/**
 * R009 Stage 6（Auto Update）：update 组 IPC handler。
 *
 * 五个通道均为无入参（parseNoInput）：状态机与平台分流全部在 Main 侧
 * DesktopUpdateService 内，Renderer 只触发意图（检查/下载/安装/打开
 * Release 页）并消费 UpdateStatus。
 */
import { IPC_CHANNELS } from "../../../shared/ipc/contracts.js";
import { parseNoInput } from "../../../shared/ipc/schemas.js";
import type { DesktopUpdateService } from "../update/DesktopUpdateService.js";
import { handleRequest, type IpcMainLike } from "./handler.js";

export interface UpdateHandlerDeps {
  service: DesktopUpdateService;
}

export function registerUpdateHandlers(
  bus: IpcMainLike,
  deps: UpdateHandlerDeps,
): void {
  const { service } = deps;

  bus.handle(
    IPC_CHANNELS.updateGetState,
    handleRequest(parseNoInput, () => service.getState()),
  );

  bus.handle(
    IPC_CHANNELS.updateCheck,
    handleRequest(parseNoInput, () => service.check()),
  );

  bus.handle(
    IPC_CHANNELS.updateDownload,
    handleRequest(parseNoInput, () => service.download()),
  );

  bus.handle(
    IPC_CHANNELS.updateInstall,
    handleRequest(parseNoInput, () => service.install()),
  );

  bus.handle(
    IPC_CHANNELS.updateOpenReleasePage,
    handleRequest(parseNoInput, () => service.openReleasePage()),
  );
}
