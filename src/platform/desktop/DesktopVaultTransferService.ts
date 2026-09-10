/**
 * R014：Desktop Vault 搬迁 / 跨库复制移动——IPC plan/execute + dirty 注入。
 */
import { DomainError } from "../../domain/errors";
import type {
  VaultTransferPlanRequest,
  VaultTransferService,
} from "../../application/vaultTransfer/VaultTransferService";
import type {
  VaultTransferPlan,
  VaultTransferRecoveryResult,
  VaultTransferRecoveryStatus,
  VaultTransferResult,
} from "../../../shared/vaultTransfer/types";
import { VAULT_TRANSFER_BLOCKER_CODES } from "../../../shared/vaultTransfer/types";
import { type E1DesktopAPI } from "./desktopApi";
import type { DesktopVaultScanCache } from "./DesktopVaultScanCache";
import type { DesktopLinkIndex } from "./DesktopLinkIndex";
import type { DesktopSearchIndex } from "./DesktopSearchIndex";
import { mapFileOpError } from "./repositories";

export interface DesktopVaultTransferServiceDeps {
  api: E1DesktopAPI;
  scans: DesktopVaultScanCache;
  linkIndex?: DesktopLinkIndex;
  fullTextSearch?: DesktopSearchIndex;
  getDirtyRelativePaths?: () => ReadonlySet<string>;
}

export class DesktopVaultTransferService implements VaultTransferService {
  constructor(private readonly deps: DesktopVaultTransferServiceDeps) {}

  async pickDirectory(): Promise<string | null> {
    const selected = await this.deps.api.vault.selectDirectory();
    if (!selected) return null;
    return selected.selectionToken;
  }

  async plan(request: VaultTransferPlanRequest): Promise<VaultTransferPlan> {
    let sourceRelativePath = request.sourceRelativePath;
    if (!sourceRelativePath && request.pageId) {
      const found = await this.deps.scans.findEntry(request.pageId);
      if (!found) {
        throw new DomainError(
          "PAGE_NOT_FOUND",
          "这个页面已经不存在，它可能已经被其他程序移动或删除。",
        );
      }
      sourceRelativePath = found.entry.relativePath;
      if (!request.sourceVaultId) {
        request = { ...request, sourceVaultId: found.vaultId };
      }
    }

    let plan: VaultTransferPlan;
    try {
      plan = await this.deps.api.vaultTransfer.plan({
        kind: request.kind,
        sourceVaultId: request.sourceVaultId,
        destinationVaultId: request.destinationVaultId,
        sourceRelativePath,
        destinationRelativePath: request.destinationRelativePath,
        selectionToken: request.selectionToken,
        newFolderName: request.newFolderName,
      });
    } catch (err) {
      mapFileOpError(err);
    }

    const dirty = this.deps.getDirtyRelativePaths?.() ?? new Set();
    if (
      request.kind === "relocate-vault" &&
      dirty.size > 0
    ) {
      plan.blockers.push({
        code: VAULT_TRANSFER_BLOCKER_CODES.dirty,
        message: "有未保存的文档，请先保存或丢弃后再移动知识库。",
      });
    }
    if (
      request.kind.startsWith("copy-") ||
      request.kind.startsWith("move-")
    ) {
      for (const note of plan.notes) {
        if (dirty.has(note.sourcePath)) {
          plan.blockers.push({
            code: VAULT_TRANSFER_BLOCKER_CODES.dirty,
            message: `「${note.sourcePath}」有未保存更改，请先保存或丢弃后再操作。`,
            relativePath: note.sourcePath,
          });
        }
      }
    }
    return plan;
  }

  async execute(plan: VaultTransferPlan): Promise<VaultTransferResult> {
    let result: VaultTransferResult;
    try {
      result = await this.deps.api.vaultTransfer.execute({ plan });
    } catch (err) {
      mapFileOpError(err);
    }

    let indexReconcileFailed = false;
    try {
      await this.reconcileAfterSuccess(plan);
    } catch (err) {
      console.warn("跨库/搬迁后索引协调失败", err);
      indexReconcileFailed = true;
    }
    this.deps.scans.invalidate(plan.sourceVaultId);
    if (plan.destinationVaultId) {
      this.deps.scans.invalidate(plan.destinationVaultId);
    }
    return { ...result, indexReconcileFailed };
  }

  async getRecoveryStatus(): Promise<VaultTransferRecoveryStatus> {
    try {
      return await this.deps.api.vaultTransfer.recoveryStatus();
    } catch (err) {
      mapFileOpError(err);
    }
  }

  async recover(): Promise<VaultTransferRecoveryResult> {
    try {
      return await this.deps.api.vaultTransfer.recover();
    } catch (err) {
      mapFileOpError(err);
    }
  }

  private async reconcileAfterSuccess(plan: VaultTransferPlan): Promise<void> {
    const { linkIndex, fullTextSearch } = this.deps;
    if (plan.kind === "relocate-missing" || plan.kind === "relocate-vault") {
      return;
    }
    const destId = plan.destinationVaultId;
    if (destId && linkIndex) await linkIndex.rebuild(destId);
    if (destId && fullTextSearch) await fullTextSearch.rebuild(destId);
    if (plan.kind.startsWith("move-")) {
      if (linkIndex) await linkIndex.rebuild(plan.sourceVaultId);
      if (fullTextSearch) await fullTextSearch.rebuild(plan.sourceVaultId);
    }
  }
}
