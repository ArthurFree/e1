/**
 * R011 Stage 2/5：fileOperation 组 + vault.rename IPC。
 */
import {
  IPC_CHANNELS,
  type FileOperationExecuteInput,
  type FileOperationPlanDto,
  type FileOperationPlanInput,
  type FileOperationRecoveryResultDto,
  type FileOperationRecoveryStatusDto,
  type FileOperationResultDto,
  type FileOperationVaultInput,
  type RenameVaultInput,
  type RenameVaultResult,
} from "../../../shared/ipc/contracts.js";
import { IpcFailure } from "../../../shared/errors.js";
import { handleRequest, type IpcMainLike } from "./handler.js";
import {
  resolveVaultRoot,
  type VaultRootDeps,
} from "../vaultRoots.js";
import { planFileOperation } from "../filesystem/DesktopFileOperationPlanner.js";
import {
  executeFileOperationPlan,
  recoverPendingFileOperations,
} from "../filesystem/JournaledFileOperationEngine.js";
import { listPendingJournals } from "../filesystem/FileOperationJournal.js";
import { readVault, type VaultMeta } from "../filesystem/VaultFileSystem.js";
import { atomicWriteJson } from "../filesystem/FileOperationJournal.js";
import { join } from "node:path";
import type { LinkIndexProvider } from "./links.js";
import type { SelfWriteRegistry } from "../watcher/SelfWriteRegistry.js";
import type { VaultRegistry } from "../vaultRegistry.js";

export interface FileOperationHandlerDeps extends VaultRootDeps {
  indexes: LinkIndexProvider;
  selfWrites: SelfWriteRegistry;
  registry: VaultRegistry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new IpcFailure("INVALID_INPUT", `${key} 必须为非空字符串`);
  }
  return v;
}

export function parseFileOperationPlanInput(
  payload: unknown,
): FileOperationPlanInput {
  if (!isRecord(payload)) {
    throw new IpcFailure("INVALID_INPUT", "fileOperation.plan 入参必须为对象");
  }
  const kind = requireString(payload, "kind") as FileOperationPlanInput["kind"];
  const vaultId = requireString(payload, "vaultId");
  return {
    kind,
    vaultId,
    ...(typeof payload.fromRelativePath === "string"
      ? { fromRelativePath: payload.fromRelativePath }
      : {}),
    ...(typeof payload.toRelativePath === "string"
      ? { toRelativePath: payload.toRelativePath }
      : {}),
    ...(typeof payload.newName === "string" ? { newName: payload.newName } : {}),
    ...(typeof payload.workspaceName === "string"
      ? { workspaceName: payload.workspaceName }
      : {}),
  };
}

export function parseFileOperationExecuteInput(
  payload: unknown,
): FileOperationExecuteInput {
  if (!isRecord(payload) || !isRecord(payload.plan)) {
    throw new IpcFailure(
      "INVALID_INPUT",
      "fileOperation.execute 入参必须含 plan",
    );
  }
  return {
    vaultId: requireString(payload, "vaultId"),
    plan: payload.plan as unknown as FileOperationPlanDto,
  };
}

export function parseFileOperationVaultInput(
  payload: unknown,
): FileOperationVaultInput {
  if (!isRecord(payload)) {
    throw new IpcFailure("INVALID_INPUT", "入参必须为对象");
  }
  return { vaultId: requireString(payload, "vaultId") };
}

export function parseRenameVaultInput(payload: unknown): RenameVaultInput {
  if (!isRecord(payload)) {
    throw new IpcFailure("INVALID_INPUT", "vault.rename 入参必须为对象");
  }
  return {
    vaultId: requireString(payload, "vaultId"),
    name: requireString(payload, "name"),
  };
}

export function registerFileOperationHandlers(
  bus: IpcMainLike,
  deps: FileOperationHandlerDeps,
): void {
  bus.handle(
    IPC_CHANNELS.fileOperationPlan,
    handleRequest(parseFileOperationPlanInput, async (input) => {
      const root = await resolveVaultRoot(input.vaultId, deps);
      if (root.transient) {
        throw new IpcFailure("VAULT_READ_ONLY", "预览知识库不可执行文件操作。");
      }
      return planFileOperation({
        vaultRoot: root.absolutePath,
        request: input,
        links: deps.indexes.linksFor(input.vaultId),
      });
    }),
  );

  bus.handle(
    IPC_CHANNELS.fileOperationExecute,
    handleRequest(parseFileOperationExecuteInput, async (input) => {
      const root = await resolveVaultRoot(input.vaultId, deps);
      if (root.transient) {
        throw new IpcFailure("VAULT_READ_ONLY", "预览知识库不可执行文件操作。");
      }
      if (input.plan.kind === "rename-workspace") {
        throw new IpcFailure(
          "INVALID_INPUT",
          "请使用 vault.rename 修改知识库名称。",
        );
      }
      const result = await executeFileOperationPlan({
        vaultRoot: root.absolutePath,
        plan: input.plan as unknown as import("../../../shared/fileOperations/types.js").FileOperationPlan,
        deps: { selfWrites: deps.selfWrites },
      });
      return result as FileOperationResultDto;
    }),
  );

  bus.handle(
    IPC_CHANNELS.fileOperationRecoveryStatus,
    handleRequest(
      parseFileOperationVaultInput,
      async (input): Promise<FileOperationRecoveryStatusDto> => {
        const root = await resolveVaultRoot(input.vaultId, deps);
        const pending = await listPendingJournals(root.absolutePath);
        if (pending.length === 0) {
          return {
            vaultId: input.vaultId,
            phase: "clean",
            pendingOperationIds: [],
          };
        }
        const incompatible = pending.some((j) => j.version !== 1);
        return {
          vaultId: input.vaultId,
          phase: incompatible ? "manual-required" : "recoverable",
          pendingOperationIds: pending.map((j) => j.operationId),
          message: incompatible
            ? "发现不兼容的文件操作日志。"
            : "检测到未完成的文件操作，可自动恢复。",
        };
      },
    ),
  );

  bus.handle(
    IPC_CHANNELS.fileOperationRecover,
    handleRequest(
      parseFileOperationVaultInput,
      async (input): Promise<FileOperationRecoveryResultDto> => {
        const root = await resolveVaultRoot(input.vaultId, deps);
        const result = await recoverPendingFileOperations({
          vaultRoot: root.absolutePath,
        });
        if (result.manualRequired) {
          throw new IpcFailure(
            "FILE_OPERATION_RECOVERY_REQUIRED",
            result.message ?? "需要人工介入恢复文件操作。",
          );
        }
        return {
          vaultId: input.vaultId,
          recovered: result.recovered,
          rolledBackOperationIds: result.rolledBackOperationIds,
          message: result.message,
        };
      },
    ),
  );

  bus.handle(
    IPC_CHANNELS.vaultRename,
    handleRequest(parseRenameVaultInput, async (input): Promise<RenameVaultResult> => {
      const root = await resolveVaultRoot(input.vaultId, deps);
      if (root.transient) {
        throw new IpcFailure("VAULT_READ_ONLY", "预览知识库不可重命名。");
      }
      const name = input.name.trim();
      if (!name) {
        throw new IpcFailure("INVALID_INPUT", "知识库名称不能为空。");
      }
      const current = await readVault(root.absolutePath);
      if (current.status !== "initialized") {
        throw new IpcFailure("VAULT_NOT_FOUND", "知识库尚未初始化。");
      }
      const next: VaultMeta = { ...current.meta, name };
      await atomicWriteJson(
        join(root.absolutePath, ".e1", "vault.json"),
        next,
      );
      try {
        await deps.registry.updateDisplayName(input.vaultId, name);
      } catch {
        // best-effort：注册表失败不回滚 vault.json
      }
      return { vaultId: input.vaultId, name };
    }),
  );
}
