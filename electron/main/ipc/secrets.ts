/**
 * R008 Stage 1（§8.3/§8.6，G2）：secret 组 IPC handler。
 *
 * Renderer 只经本组访问机密（与 SecretStore port 一一对应 + status）：
 * - status：机密存储运行状态（SecretStorageStatus，R8-02——能力字段
 *   nativeSecrets 表示集成存在，本状态表示本机实际后端）；
 *   secure-persistent 才落盘，session-only / unavailable 时 Main 降级
 *   会话内存（重启丢失），绝不弱保护落盘（SecretFilePersistence 保证）；
 * - get/set/delete：透传 SecretFilePersistence。
 * Renderer 不可知（§8.3）：存储路径、加密原始 buffer、密钥链标识、
 * 本机绝对路径。机密值不进日志、不进 error details（§15.2）。
 */
import {
  IPC_CHANNELS,
  type SecretStorageStatus,
} from "../../../shared/ipc/contracts.js";
import {
  parseNoInput,
  parseSecretNameRequest,
  parseSecretSetInput,
} from "../../../shared/ipc/schemas.js";
import type { SecretFilePersistence } from "../secrets/SecretFilePersistence.js";
import { handleRequest, type IpcMainLike } from "./handler.js";

export interface SecretHandlerDeps {
  store: SecretFilePersistence;
  /** R008 §8.6：后端状态评估（SecretBackendStatus.evaluate）。 */
  status: () => SecretStorageStatus;
}

export function registerSecretHandlers(
  bus: IpcMainLike,
  deps: SecretHandlerDeps,
): void {
  const { store } = deps;

  bus.handle(
    IPC_CHANNELS.secretStatus,
    handleRequest(parseNoInput, (): SecretStorageStatus => deps.status()),
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
