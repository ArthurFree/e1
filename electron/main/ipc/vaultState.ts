/**
 * R007 阶段 2（DSK-04）：vaultState 组 IPC handler。
 *
 * 设备级交互状态（收藏/最近打开）读写，落 userData/vault-state/<vaultId>.json：
 * - 常规 Vault：vaultId 必须已登记注册表（否则 VAULT_NOT_FOUND）；
 *   不做目录可达性复查——状态读写不依赖 Vault 目录在线，目录暂时不可
 *   访问不应拖垮知识库列表（与「state 损坏自愈不影响打开」同口径）。
 * - transient 仅预览会话：不落盘——get 返回空表、patch 在内存合并后
 *   返回但不写文件（重启消失，与 transient 语义一致）。
 */
import {
  IPC_CHANNELS,
  createEmptyVaultState,
  type VaultState,
} from "../../../shared/ipc/contracts.js";
import { IpcFailure } from "../../../shared/errors.js";
import {
  parsePatchVaultStateInput,
  parseVaultStateGetInput,
} from "../../../shared/ipc/schemas.js";
import type { DesktopVaultStateStore } from "../state/DesktopVaultStateStore.js";
import type { VaultRootDeps } from "../vaultRoots.js";
import { handleRequest, type IpcMainLike } from "./handler.js";

export interface VaultStateHandlerDeps extends VaultRootDeps {
  store: DesktopVaultStateStore;
}

export function registerVaultStateHandlers(
  bus: IpcMainLike,
  deps: VaultStateHandlerDeps,
): void {
  const { store } = deps;
  const isTransient = (vaultId: string) =>
    Boolean(deps.transients?.find(vaultId));
  const assertRegistered = async (vaultId: string): Promise<void> => {
    const record = await deps.registry?.findByVaultId(vaultId);
    if (!record) {
      throw new IpcFailure(
        "VAULT_NOT_FOUND",
        `vaultId 未登记（请先打开对应知识库）：${vaultId}`,
      );
    }
  };

  bus.handle(
    IPC_CHANNELS.vaultStateGet,
    handleRequest(
      parseVaultStateGetInput,
      async (vaultId): Promise<VaultState> => {
        if (isTransient(vaultId)) return createEmptyVaultState();
        await assertRegistered(vaultId);
        return store.get(vaultId);
      },
    ),
  );

  bus.handle(
    IPC_CHANNELS.vaultStatePatch,
    handleRequest(
      parsePatchVaultStateInput,
      async (input): Promise<VaultState> => {
        if (isTransient(input.vaultId)) return createEmptyVaultState();
        await assertRegistered(input.vaultId);
        return store.patch(input.vaultId, input.patch);
      },
    ),
  );
}
