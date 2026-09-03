/**
 * R011：Desktop 文件操作服务——IPC plan/execute + 成功后显式 reconcile。
 */
import { DomainError } from "../../domain/errors";
import type { FileOperationService } from "../../application/fileOperations/FileOperationService";
import type {
  FileOperationPlan,
  FileOperationRecoveryResult,
  FileOperationRecoveryStatus,
  FileOperationRequest,
  FileOperationResult,
} from "../../application/fileOperations/FileOperationService";
import { type E1DesktopAPI } from "./desktopApi";
import type { DesktopVaultScanCache } from "./DesktopVaultScanCache";
import type { DesktopDocumentSourceCache } from "./DesktopDocumentSourceCache";
import type { DesktopLinkIndex } from "./DesktopLinkIndex";
import type { DesktopSearchIndex } from "./DesktopSearchIndex";
import { mapFileOpError } from "./repositories";

export interface DesktopFileOperationServiceDeps {
  api: E1DesktopAPI;
  scans: DesktopVaultScanCache;
  sources?: DesktopDocumentSourceCache;
  linkIndex?: DesktopLinkIndex;
  fullTextSearch?: DesktopSearchIndex;
  /** 返回当前 dirty / pending-save 文档的 relativePath 集合。 */
  getDirtyRelativePaths?: () => ReadonlySet<string>;
}

export class DesktopFileOperationService implements FileOperationService {
  constructor(private readonly deps: DesktopFileOperationServiceDeps) {}

  async plan(request: FileOperationRequest): Promise<FileOperationPlan> {
    let fromRelativePath = request.fromRelativePath;
    if (!fromRelativePath && request.pageId) {
      const found = await this.deps.scans.findEntry(request.pageId);
      if (!found) {
        throw new DomainError(
          "PAGE_NOT_FOUND",
          "这个页面已经不存在，它可能已经被其他程序移动或删除。",
        );
      }
      fromRelativePath = found.entry.relativePath;
      if (!request.vaultId) {
        request = { ...request, vaultId: found.vaultId };
      }
    }

    let plan: FileOperationPlan;
    try {
      plan = (await this.deps.api.fileOperation.plan({
        kind: request.kind,
        vaultId: request.vaultId,
        fromRelativePath,
        toRelativePath: request.toRelativePath,
        newName: request.newName,
        workspaceName: request.workspaceName,
      })) as FileOperationPlan;
    } catch (err) {
      mapFileOpError(err);
    }

    const dirty = this.deps.getDirtyRelativePaths?.() ?? new Set();
    if (dirty.size > 0) {
      for (const patch of plan.patches) {
        if (dirty.has(patch.sourceRelativePathBefore)) {
          plan.blockers.push({
            code: "FILE_OPERATION_BLOCKED_DIRTY",
            message: `「${patch.sourceRelativePathBefore}」有未保存更改，请先保存或丢弃后再操作。`,
            pageId: patch.sourcePageId,
            relativePath: patch.sourceRelativePathBefore,
          });
        }
      }
      for (const move of plan.pathMoves) {
        if (
          move.kind === "document" &&
          dirty.has(move.fromRelativePath)
        ) {
          plan.blockers.push({
            code: "FILE_OPERATION_BLOCKED_DIRTY",
            message: `「${move.fromRelativePath}」有未保存更改，请先保存或丢弃后再操作。`,
            relativePath: move.fromRelativePath,
          });
        }
      }
    }
    return plan;
  }

  async execute(plan: FileOperationPlan): Promise<FileOperationResult> {
    if (plan.kind === "rename-workspace") {
      if (!plan.target.workspaceName) {
        throw new DomainError("INVALID_INPUT", "知识库名称不能为空。");
      }
      try {
        await this.deps.api.vault.rename({
          vaultId: plan.vaultId,
          name: plan.target.workspaceName,
        });
      } catch (err) {
        mapFileOpError(err);
      }
      return {
        operationId: plan.operationId,
        kind: plan.kind,
        vaultId: plan.vaultId,
        pathMoves: [],
        rewrittenDocuments: 0,
        rewrittenLinks: 0,
      };
    }

    let result: FileOperationResult;
    try {
      result = (await this.deps.api.fileOperation.execute({
        vaultId: plan.vaultId,
        plan: plan as never,
      })) as FileOperationResult;
    } catch (err) {
      mapFileOpError(err);
    }

    // 显式 reconcile：不依赖被抑制的 watcher。
    let indexReconcileFailed = false;
    try {
      await this.reconcileAfterSuccess(plan, result);
    } catch (err) {
      console.warn("文件操作后索引协调失败", err);
      indexReconcileFailed = true;
    }
    this.deps.scans.invalidate(plan.vaultId);
    return { ...result, indexReconcileFailed };
  }

  private async reconcileAfterSuccess(
    plan: FileOperationPlan,
    result: FileOperationResult,
  ): Promise<void> {
    const { sources, linkIndex, fullTextSearch } = this.deps;
    const isGroupOp =
      plan.kind === "rename-group" || plan.kind === "move-group";

    for (const move of result.pathMoves) {
      if (move.kind === "document" && sources) {
        // 会话页面 id 可能是 stable id 或 path 键——两侧都试更新。
        if (move.noteKey) {
          sources.updateRelativePath(move.noteKey, move.toRelativePath);
        }
        sources.updateRelativePath(
          `path:${move.fromRelativePath}`,
          move.toRelativePath,
        );
      }
    }

    // 分组操作：前缀 remap 源缓存 + 全量 rebuild 索引。
    if (isGroupOp && plan.target.fromRelativePath && plan.target.toRelativePath) {
      sources?.remapPathPrefix(
        plan.target.fromRelativePath,
        plan.target.toRelativePath,
      );
      if (linkIndex) await linkIndex.rebuild(plan.vaultId);
      if (fullTextSearch) await fullTextSearch.rebuild(plan.vaultId);
      return;
    }

    for (const move of result.pathMoves) {
      if (move.kind !== "document") continue;
      try {
        await linkIndex?.relocate({
          vaultId: plan.vaultId,
          noteKey: move.noteKey ?? undefined,
          fromRelativePath: move.fromRelativePath,
          toRelativePath: move.toRelativePath,
        });
      } catch (err) {
        console.warn("link relocate 失败", err);
      }
      try {
        const pageId = move.noteKey ?? `path:${move.fromRelativePath}`;
        await fullTextSearch?.relocate({
          vaultId: plan.vaultId,
          pageId,
          relativePath: move.toRelativePath,
        });
      } catch (err) {
        console.warn("search relocate 失败", err);
      }
    }

    // 被改写但未移动的文档：upsert 刷新链接。
    for (const patch of plan.patches) {
      const moved = result.pathMoves.some(
        (m) => m.fromRelativePath === patch.sourceRelativePathBefore,
      );
      if (moved) continue;
      try {
        await linkIndex?.upsert({
          vaultId: plan.vaultId,
          relativePath: patch.sourceRelativePathAfter,
        });
      } catch {
        // soft
      }
    }
  }

  async getRecoveryStatus(
    vaultId: string,
  ): Promise<FileOperationRecoveryStatus> {
    try {
      return await this.deps.api.fileOperation.recoveryStatus({ vaultId });
    } catch (err) {
      mapFileOpError(err);
    }
  }

  async recover(vaultId: string): Promise<FileOperationRecoveryResult> {
    try {
      return await this.deps.api.fileOperation.recover({ vaultId });
    } catch (err) {
      mapFileOpError(err);
    }
  }
}
