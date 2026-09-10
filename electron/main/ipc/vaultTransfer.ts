/**
 * R014：vaultTransfer 组 IPC——plan / execute / recovery。
 * 目录选择令牌在 plan 时消费，绝对路径只留在 Main 的 pending 表。
 */
import { parseNoInput } from "../../../shared/ipc/schemas.js";
import {
  IPC_CHANNELS,
  type VaultTransferPlan,
  type VaultTransferRecoveryResult,
  type VaultTransferRecoveryStatus,
  type VaultTransferRequest,
  type VaultTransferResult,
} from "../../../shared/ipc/contracts.js";
import { IpcFailure } from "../../../shared/errors.js";
import type { VaultTransferKind } from "../../../shared/vaultTransfer/types.js";
import { handleRequest, type IpcMainLike } from "./handler.js";
import type { SelectionTokenStore } from "../SelectionTokenStore.js";
import type { VaultRegistry } from "../vaultRegistry.js";
import type { VaultRootDeps } from "../vaultRoots.js";
import type { VaultWatcherService } from "../watcher/VaultWatcher.js";
import {
  executeRelocateMissing,
  executeRelocateVault,
  planRelocateMissing,
  planRelocateVault,
  recoverRelocations,
  relocationJournalDir,
} from "../vaultTransfer/VaultRelocationEngine.js";
import {
  executeCrossVaultTransfer,
  planCrossVaultTransfer,
} from "../vaultTransfer/VaultTransferEngine.js";

const KINDS: VaultTransferKind[] = [
  "relocate-missing",
  "relocate-vault",
  "copy-document",
  "copy-group",
  "move-document",
  "move-group",
];

export interface VaultTransferHandlerDeps extends VaultRootDeps {
  registry: VaultRegistry;
  selectionTokens: SelectionTokenStore;
  userDataDir: string;
  watchers?: Pick<VaultWatcherService, "restartWatching">;
}

interface PendingDest {
  destinationAbsolutePath?: string;
  destinationParentAbsolutePath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new IpcFailure("INVALID_INPUT", `${key} 必须为非空字符串`);
  }
  return v;
}

function parseRequest(payload: unknown): VaultTransferRequest {
  if (!isRecord(payload)) {
    throw new IpcFailure("INVALID_INPUT", "vaultTransfer.plan 入参必须为对象");
  }
  const kind = requireString(payload, "kind") as VaultTransferKind;
  if (!KINDS.includes(kind)) {
    throw new IpcFailure("INVALID_INPUT", `未知的 vaultTransfer kind：${kind}`);
  }
  return {
    kind,
    sourceVaultId: requireString(payload, "sourceVaultId"),
    ...(typeof payload.destinationVaultId === "string"
      ? { destinationVaultId: payload.destinationVaultId }
      : {}),
    ...(typeof payload.sourceRelativePath === "string"
      ? { sourceRelativePath: payload.sourceRelativePath }
      : {}),
    ...(typeof payload.destinationRelativePath === "string"
      ? { destinationRelativePath: payload.destinationRelativePath }
      : {}),
    ...(typeof payload.selectionToken === "string"
      ? { selectionToken: payload.selectionToken }
      : {}),
    ...(typeof payload.newFolderName === "string"
      ? { newFolderName: payload.newFolderName }
      : {}),
  };
}

function parseExecute(
  payload: unknown,
): { plan: VaultTransferPlan } {
  if (!isRecord(payload) || !isRecord(payload.plan)) {
    throw new IpcFailure("INVALID_INPUT", "vaultTransfer.execute 需要 plan 对象");
  }
  const plan = payload.plan as unknown as VaultTransferPlan;
  if (typeof plan.operationId !== "string" || typeof plan.kind !== "string") {
    throw new IpcFailure("INVALID_INPUT", "plan.operationId / kind 非法");
  }
  return { plan };
}

export function registerVaultTransferHandlers(
  bus: IpcMainLike,
  deps: VaultTransferHandlerDeps,
): void {
  const pending = new Map<string, PendingDest>();
  const journalDir = relocationJournalDir(deps.userDataDir);

  bus.handle(
    IPC_CHANNELS.vaultTransferPlan,
    handleRequest(parseRequest, async (request): Promise<VaultTransferPlan> => {
      if (request.kind === "relocate-missing") {
        if (!request.selectionToken) {
          throw new IpcFailure("INVALID_INPUT", "重新定位需要选择目标目录");
        }
        const dest = deps.selectionTokens.consume(request.selectionToken);
        const plan = await planRelocateMissing({
          sourceVaultId: request.sourceVaultId,
          destinationAbsolutePath: dest,
          registry: deps.registry,
        });
        pending.set(plan.operationId, { destinationAbsolutePath: dest });
        return plan;
      }
      if (request.kind === "relocate-vault") {
        if (!request.selectionToken) {
          throw new IpcFailure("INVALID_INPUT", "移动知识库需要选择目标父目录");
        }
        const parent = deps.selectionTokens.consume(request.selectionToken);
        const newFolderName = request.newFolderName?.trim();
        if (!newFolderName) {
          throw new IpcFailure("INVALID_INPUT", "移动知识库需要新文件夹名");
        }
        const plan = await planRelocateVault({
          sourceVaultId: request.sourceVaultId,
          destinationParentAbsolutePath: parent,
          newFolderName,
          registry: deps.registry,
        });
        pending.set(plan.operationId, {
          destinationParentAbsolutePath: parent,
        });
        return plan;
      }
      if (!request.destinationVaultId || !request.sourceRelativePath) {
        throw new IpcFailure(
          "INVALID_INPUT",
          "跨库操作需要 destinationVaultId 与 sourceRelativePath",
        );
      }
      return planCrossVaultTransfer({
        kind: request.kind,
        sourceVaultId: request.sourceVaultId,
        destinationVaultId: request.destinationVaultId,
        sourceRelativePath: request.sourceRelativePath,
        destinationRelativePath: request.destinationRelativePath ?? "",
        roots: deps,
      });
    }),
  );

  bus.handle(
    IPC_CHANNELS.vaultTransferExecute,
    handleRequest(parseExecute, async ({ plan }): Promise<VaultTransferResult> => {
      if (plan.kind === "relocate-missing") {
        const dest = pending.get(plan.operationId)?.destinationAbsolutePath;
        if (!dest) {
          throw new IpcFailure(
            "VAULT_TRANSFER_STALE_PLAN",
            "重新定位授权已失效，请重新选择目录。",
          );
        }
        const result = await executeRelocateMissing({
          plan,
          destinationAbsolutePath: dest,
          registry: deps.registry,
        });
        pending.delete(plan.operationId);
        await deps.watchers?.restartWatching(plan.sourceVaultId, dest);
        return result;
      }
      if (plan.kind === "relocate-vault") {
        const parent =
          pending.get(plan.operationId)?.destinationParentAbsolutePath;
        if (!parent) {
          throw new IpcFailure(
            "VAULT_TRANSFER_STALE_PLAN",
            "移动授权已失效，请重新选择目录。",
          );
        }
        const result = await executeRelocateVault({
          plan,
          destinationParentAbsolutePath: parent,
          journalDir,
          registry: deps.registry,
          onRootChanged: async (vaultId, absolutePath) => {
            await deps.watchers?.restartWatching(vaultId, absolutePath);
          },
        });
        pending.delete(plan.operationId);
        return result;
      }
      return executeCrossVaultTransfer({ plan, roots: deps });
    }),
  );

  bus.handle(
    IPC_CHANNELS.vaultTransferRecoveryStatus,
    handleRequest(parseNoInput, async (): Promise<VaultTransferRecoveryStatus> => {
      const { recovered, manual } = await recoverRelocations({
        journalDir,
        registry: deps.registry,
      });
      void recovered;
      if (manual.length > 0) {
        return {
          phase: "manual-required",
          pendingOperationIds: manual,
          message: "存在未完成的知识库搬迁，需要人工确认。",
        };
      }
      return { phase: "clean", pendingOperationIds: [] };
    }),
  );

  bus.handle(
    IPC_CHANNELS.vaultTransferRecover,
    handleRequest(parseNoInput, async (): Promise<VaultTransferRecoveryResult> => {
      const { recovered, manual } = await recoverRelocations({
        journalDir,
        registry: deps.registry,
        onRootChanged: async (vaultId, absolutePath) => {
          await deps.watchers?.restartWatching(vaultId, absolutePath);
        },
      });
      return {
        recovered: manual.length === 0,
        rolledBackOperationIds: recovered,
        message:
          manual.length > 0
            ? "部分搬迁处于目标已就绪但源未删除，未自动删除源目录。"
            : undefined,
      };
    }),
  );
}
