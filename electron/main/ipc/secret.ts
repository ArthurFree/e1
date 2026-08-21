/**
 * R008 Stage 1（§8.3）：secret 组 IPC handler。
 *
 * 机密值（当前仅 AI API Key）读写——Main 侧 DesktopSecretStore 经
 * safeStorage 加解密后落 userData/secrets.json（不安全 backend 时
 * session-only 不落盘）。与 vault 无关：不校验 vaultId、不触碰 Vault
 * 授权边界（secret 属设备级状态，与 Vault 内容隔离）。
 *
 * Renderer 不得知道存储路径/原始密文/keychain 标识；handler 永不 throw，
 * 错误经 handleRequest 归一为 IpcResult 信封，错误 details 不携带
 * secret 值（§15.1/§15.2）。
 */
import { IPC_CHANNELS } from "../../../shared/ipc/contracts.js";
import {
  parseNoInput,
  parseSecretGetInput,
  parseSecretRemoveInput,
  parseSecretSetInput,
} from "../../../shared/ipc/schemas.js";
import type { DesktopSecretStore } from "../secrets/DesktopSecretStore.js";
import { handleRequest, type IpcMainLike } from "./handler.js";

export interface SecretHandlerDeps {
  store: DesktopSecretStore;
}

export function registerSecretHandlers(
  bus: IpcMainLike,
  deps: SecretHandlerDeps,
): void {
  const { store } = deps;

  bus.handle(
    IPC_CHANNELS.secretGet,
    handleRequest(parseSecretGetInput, (input) => store.get(input.name)),
  );

  bus.handle(
    IPC_CHANNELS.secretSet,
    handleRequest(parseSecretSetInput, async (input): Promise<null> => {
      await store.set(input.name, input.value);
      return null;
    }),
  );

  bus.handle(
    IPC_CHANNELS.secretRemove,
    handleRequest(parseSecretRemoveInput, async (input): Promise<null> => {
      await store.remove(input.name);
      return null;
    }),
  );

  bus.handle(
    IPC_CHANNELS.secretGetStatus,
    handleRequest(parseNoInput, () => store.getStatus()),
  );
}
