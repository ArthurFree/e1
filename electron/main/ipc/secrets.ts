/**
 * R007 阶段 5（§5.1，G3）：secret 组 IPC handler。
 *
 * Renderer 只经本组访问机密（与 SecretStore port 一一对应 + status）：
 * - status：系统安全存储（safeStorage）是否可用；false 时 Main 降级为
 *   会话内存（重启丢失），Renderer 据此置 capabilities.nativeSecrets=false
 *   并提示「本次会话使用」——绝不明文落盘（DesktopSecretPersistence 保证）；
 * - get/set/delete：透传 DesktopSecretPersistence。
 * 机密值不进日志、不进 error details（R007 §15）。
 */
import {
  IPC_CHANNELS,
  type SecretStatusResult,
} from "../../../shared/ipc/contracts.js";
import {
  parseNoInput,
  parseSecretNameRequest,
  parseSecretSetInput,
} from "../../../shared/ipc/schemas.js";
import type { DesktopSecretPersistence } from "../state/DesktopSecretPersistence.js";
import { handleRequest, type IpcMainLike } from "./handler.js";

export interface SecretHandlerDeps {
  store: DesktopSecretPersistence;
}

export function registerSecretHandlers(
  bus: IpcMainLike,
  deps: SecretHandlerDeps,
): void {
  const { store } = deps;

  bus.handle(
    IPC_CHANNELS.secretStatus,
    handleRequest(parseNoInput, (): SecretStatusResult => {
      return { available: store.isAvailable() };
    }),
  );

  bus.handle(
    IPC_CHANNELS.secretGet,
    handleRequest(parseSecretNameRequest, (name): Promise<string | null> => {
      return store.get(name);
    }),
  );

  bus.handle(
    IPC_CHANNELS.secretSet,
    handleRequest(parseSecretSetInput, async (input): Promise<void> => {
      await store.set(input.name, input.value);
    }),
  );

  bus.handle(
    IPC_CHANNELS.secretDelete,
    handleRequest(parseSecretNameRequest, async (name): Promise<void> => {
      await store.remove(name);
    }),
  );
}
