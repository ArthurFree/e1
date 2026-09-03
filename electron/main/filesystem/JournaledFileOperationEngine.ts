/**
 * R011 Stage 2：Journaled 文件操作引擎。
 *
 * 顺序：revalidate → journal → backup → rewrite Markdown → fs.rename
 * （含 case-only temp-hop）→ committed → 清 journal。
 * 失败走 rolling-back：路径回迁 + 从 backup 还原 Markdown。
 */
import { mkdir, readFile, rename as fsRename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { IpcFailure } from "../../../shared/errors.js";
import { isCaseOnlyPathChange } from "../../../shared/fileOperations/journal.js";
import type {
  FileOperationPlan,
  FileOperationResult,
  FilePathMove,
} from "../../../shared/fileOperations/types.js";
import { rewriteMarkdownLinkDestinations } from "../../../shared/links/rewriteMarkdownLinkDestinations.js";
import { sha256Token } from "./AtomicFileWriter.js";
import {
  assertNotReservedPath,
  classifyFileOperationError,
  pathExists,
  resolveAssetsDirectory,
} from "./VaultFileOperations.js";
import { resolveWithinVault } from "./PathGuard.js";
import {
  backupFile,
  createJournal,
  listPendingJournals,
  readJournal,
  removeJournal,
  restoreBackups,
  updateJournalPhase,
} from "./FileOperationJournal.js";
import type { SelfWriteRegistry } from "../watcher/SelfWriteRegistry.js";

export interface FileOperationEngineDeps {
  selfWrites?: SelfWriteRegistry;
}

/** 目录是否为另一路径的自身或后代。 */
export function isSelfOrDescendant(
  candidate: string,
  ancestor: string,
): boolean {
  if (candidate === ancestor) return true;
  const prefix = ancestor.endsWith("/") ? ancestor : `${ancestor}/`;
  return candidate.startsWith(prefix);
}

async function renamePathMove(input: {
  vaultRoot: string;
  move: FilePathMove;
  operationId: string;
  assetsDirectory: string;
}): Promise<void> {
  assertNotReservedPath(input.move.fromRelativePath, input.assetsDirectory);
  assertNotReservedPath(input.move.toRelativePath, input.assetsDirectory);
  if (
    input.move.kind === "group" &&
    isSelfOrDescendant(input.move.toRelativePath, input.move.fromRelativePath)
  ) {
    throw new IpcFailure(
      "INVALID_INPUT",
      "不能将分组移动到自身或其子目录中。",
    );
  }
  const fromAbs = await resolveWithinVault(
    input.vaultRoot,
    input.move.fromRelativePath,
  );
  const toAbs = join(input.vaultRoot, ...input.move.toRelativePath.split("/"));
  await mkdir(dirname(toAbs), { recursive: true });
  const caseOnly = isCaseOnlyPathChange(
    input.move.fromRelativePath,
    input.move.toRelativePath,
  );
  if (!caseOnly && (await pathExists(toAbs))) {
    throw new IpcFailure(
      "VAULT_PATH_COLLISION",
      `目标路径已存在：${input.move.toRelativePath}`,
    );
  }
  try {
    if (caseOnly) {
      const hop = join(
        input.vaultRoot,
        ".e1",
        "operations",
        input.operationId,
        `tmp-hop-${basename(input.move.toRelativePath)}`,
      );
      await mkdir(dirname(hop), { recursive: true });
      await fsRename(fromAbs, hop);
      await fsRename(hop, toAbs);
    } else {
      await fsRename(fromAbs, toAbs);
    }
  } catch (error) {
    throw classifyFileOperationError(error);
  }
}

/**
 * 执行已预检的 FileOperationPlan（Main 侧）。
 * workspace rename 不走本引擎（单独 vault.rename）。
 */
export async function executeFileOperationPlan(input: {
  vaultRoot: string;
  plan: FileOperationPlan;
  deps?: FileOperationEngineDeps;
}): Promise<FileOperationResult> {
  const { vaultRoot, plan } = input;
  if (plan.kind === "rename-workspace") {
    throw new IpcFailure(
      "INVALID_INPUT",
      "workspace rename 请使用 vault.rename，不经 journal 引擎。",
    );
  }
  if (plan.blockers.length > 0) {
    const dirty = plan.blockers.find(
      (b) => b.code === "FILE_OPERATION_BLOCKED_DIRTY",
    );
    throw new IpcFailure(
      dirty ? "FILE_OPERATION_BLOCKED_DIRTY" : "INVALID_INPUT",
      dirty?.message ?? plan.blockers[0]!.message,
    );
  }

  const assetsDirectory = await resolveAssetsDirectory(vaultRoot);
  const operationId = plan.operationId;

  for (const patch of plan.patches) {
    const abs = await resolveWithinVault(
      vaultRoot,
      patch.sourceRelativePathBefore,
    );
    let bytes: Buffer;
    try {
      bytes = await readFile(abs);
    } catch {
      throw new IpcFailure(
        "FILE_OPERATION_STALE_PLAN",
        `预检计划已过期：无法读取 ${patch.sourceRelativePathBefore}`,
      );
    }
    if (sha256Token(bytes) !== patch.expectedVersionToken) {
      throw new IpcFailure(
        "FILE_OPERATION_STALE_PLAN",
        `预检计划已过期：${patch.sourceRelativePathBefore} 已被外部修改。`,
      );
    }
  }

  for (const move of plan.pathMoves) {
    assertNotReservedPath(move.fromRelativePath, assetsDirectory);
    assertNotReservedPath(move.toRelativePath, assetsDirectory);
    if (
      move.kind === "group" &&
      isSelfOrDescendant(move.toRelativePath, move.fromRelativePath)
    ) {
      throw new IpcFailure(
        "INVALID_INPUT",
        "不能将分组移动到自身或其子目录中。",
      );
    }
    if (
      !isCaseOnlyPathChange(move.fromRelativePath, move.toRelativePath) &&
      (await pathExists(join(vaultRoot, ...move.toRelativePath.split("/"))))
    ) {
      throw new IpcFailure(
        "VAULT_PATH_COLLISION",
        `目标路径已存在：${move.toRelativePath}`,
      );
    }
  }

  let journal = await createJournal({
    vaultRoot,
    operationId,
    vaultId: plan.vaultId,
    kind: plan.kind,
    fromRelativePath: plan.target.fromRelativePath ?? null,
    toRelativePath: plan.target.toRelativePath ?? null,
  });

  const relocated: FilePathMove[] = [];
  let rewrittenLinks = 0;

  try {
    for (const patch of plan.patches) {
      const { backupRelativePath } = await backupFile({
        vaultRoot,
        operationId,
        originalRelativePath: patch.sourceRelativePathBefore,
        versionToken: patch.expectedVersionToken,
      });
      journal = await updateJournalPhase(vaultRoot, journal, journal.phase, {
        backups: [
          ...journal.backups,
          {
            originalRelativePath: patch.sourceRelativePathBefore,
            backupRelativePath,
            versionToken: patch.expectedVersionToken,
          },
        ],
      });
    }

    journal = await updateJournalPhase(vaultRoot, journal, "rewriting");
    for (const patch of plan.patches) {
      const abs = await resolveWithinVault(
        vaultRoot,
        patch.sourceRelativePathBefore,
      );
      const original = await readFile(abs, "utf8");
      const { markdown, rewrittenCount } = rewriteMarkdownLinkDestinations(
        original,
        patch.rules,
      );
      if (rewrittenCount > 0) {
        await writeFile(abs, markdown, "utf8");
        rewrittenLinks += rewrittenCount;
      }
    }

    for (const move of plan.pathMoves) {
      await renamePathMove({
        vaultRoot,
        move,
        operationId,
        assetsDirectory,
      });
      relocated.push(move);
    }
    journal = await updateJournalPhase(vaultRoot, journal, "relocated");
    journal = await updateJournalPhase(vaultRoot, journal, "committed");

    const allPaths = [
      ...plan.patches.map((p) => p.sourceRelativePathBefore),
      ...plan.pathMoves.flatMap((m) => [m.fromRelativePath, m.toRelativePath]),
    ];
    if (input.deps?.selfWrites) {
      input.deps.selfWrites.beginOperation({
        vaultId: plan.vaultId,
        operationId,
        paths: allPaths,
      });
    }

    await removeJournal(vaultRoot, operationId);

    return {
      operationId,
      kind: plan.kind,
      vaultId: plan.vaultId,
      pathMoves: relocated,
      rewrittenDocuments: plan.summary.rewrittenDocuments,
      rewrittenLinks,
    };
  } catch (error) {
    await rollbackOperation({
      vaultRoot,
      operationId,
      relocated,
    });
    if (error instanceof IpcFailure) throw error;
    throw classifyFileOperationError(error);
  }
}

async function rollbackOperation(input: {
  vaultRoot: string;
  operationId: string;
  relocated: FilePathMove[];
}): Promise<void> {
  const journal = await readJournal(input.vaultRoot, input.operationId);
  if (!journal) return;
  await updateJournalPhase(input.vaultRoot, journal, "rolling-back");

  for (const move of [...input.relocated].reverse()) {
    try {
      const fromAbs = join(input.vaultRoot, ...move.toRelativePath.split("/"));
      const toAbs = join(input.vaultRoot, ...move.fromRelativePath.split("/"));
      if (!(await pathExists(fromAbs))) continue;
      await mkdir(dirname(toAbs), { recursive: true });
      if (isCaseOnlyPathChange(move.toRelativePath, move.fromRelativePath)) {
        const hop = join(
          input.vaultRoot,
          ".e1",
          "operations",
          input.operationId,
          `tmp-hop-rollback-${basename(move.fromRelativePath)}`,
        );
        await mkdir(dirname(hop), { recursive: true });
        await fsRename(fromAbs, hop);
        await fsRename(hop, toAbs);
      } else {
        await fsRename(fromAbs, toAbs);
      }
    } catch {
      // 继续尽量恢复 backup。
    }
  }

  try {
    await restoreBackups(input.vaultRoot, journal);
  } catch {
    throw new IpcFailure(
      "FILE_OPERATION_RECOVERY_REQUIRED",
      "文件操作回滚未能完成，请打开恢复详情后再继续。",
    );
  }

  await removeJournal(input.vaultRoot, input.operationId);
}

/** 打开 Vault 时的 crash recovery：默认回滚未 committed journal。 */
export async function recoverPendingFileOperations(input: {
  vaultRoot: string;
}): Promise<{
  recovered: boolean;
  rolledBackOperationIds: string[];
  manualRequired: boolean;
  message?: string;
}> {
  const pending = await listPendingJournals(input.vaultRoot);
  if (pending.length === 0) {
    return {
      recovered: true,
      rolledBackOperationIds: [],
      manualRequired: false,
    };
  }

  const rolledBack: string[] = [];
  for (const journal of pending) {
    if (journal.version !== 1) {
      return {
        recovered: false,
        rolledBackOperationIds: rolledBack,
        manualRequired: true,
        message: "发现不兼容的文件操作日志，需要人工介入。",
      };
    }
    try {
      const relocated: FilePathMove[] = [];
      if (
        journal.phase === "relocated" &&
        journal.fromRelativePath &&
        journal.toRelativePath
      ) {
        relocated.push({
          noteKey: null,
          kind: journal.kind.includes("group") ? "group" : "document",
          fromRelativePath: journal.fromRelativePath,
          toRelativePath: journal.toRelativePath,
        });
      }
      await rollbackOperation({
        vaultRoot: input.vaultRoot,
        operationId: journal.operationId,
        relocated,
      });
      rolledBack.push(journal.operationId);
    } catch {
      return {
        recovered: false,
        rolledBackOperationIds: rolledBack,
        manualRequired: true,
        message: "上次文件操作无法自动恢复，请查看恢复详情。",
      };
    }
  }

  return {
    recovered: true,
    rolledBackOperationIds: rolledBack,
    manualRequired: false,
    message:
      rolledBack.length > 0
        ? "上次文件操作被意外中断，E1 已恢复原文件。"
        : undefined,
  };
}
