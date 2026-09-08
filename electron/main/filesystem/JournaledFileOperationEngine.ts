/**
 * R011.1（R11C-01/02/04）：Journaled 文件操作引擎（journal v2）。
 *
 * 顺序：revalidate → journal（prepare 阶段落全部 pathSteps）→ backup →
 * rewrite Markdown → relocating（逐 step：intent 落盘 → fs.rename →
 * applied 落盘；case-only temp-hop 两跳各自落盘 hopState）→ committed →
 * 清 journal。
 * 失败 / crash 恢复走 rolling-back：先按 step 逆序做路径回迁（结合
 * step.state/hopState 与 from/to/hop 实际存在状态判定，不猜测），再从
 * backup 还原 Markdown。任一回迁或还原失败 → phase=recovery-required，
 * journal 保留并抛 FILE_OPERATION_RECOVERY_REQUIRED（R11C-04）。
 */
import {
  mkdir,
  readdir,
  readFile,
  rename as fsRename,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { IpcFailure } from "../../../shared/errors.js";
import {
  isCaseOnlyPathChange,
  type FileOperationJournal,
  type JournalPathStep,
} from "../../../shared/fileOperations/journal.js";
import type {
  FileOperationPlan,
  FileOperationResult,
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
  removeJournal,
  restoreBackups,
  updateJournalPhase,
  updateJournalStep,
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

/** case-only rename 的中转路径（vault 相对，落在本操作 journal 目录内）。 */
function hopRelativePathFor(operationId: string, toRelativePath: string): string {
  return `.e1/operations/${operationId}/tmp-hop-${basename(toRelativePath)}`;
}

/**
 * 大小写敏感的存在性检测：APFS 默认大小写不敏感，case-only step 的
 * from/to 用 lstat 无法区分「Foo.md 仍在」与「已变成 foo.md」，必须按
 * 父目录实际条目名精确匹配。
 */
async function pathExistsExactName(absolutePath: string): Promise<boolean> {
  try {
    const entries = await readdir(dirname(absolutePath));
    return entries.includes(basename(absolutePath));
  } catch {
    return false;
  }
}

/** 执行单个 path step：intent 落盘 → rename → applied 落盘（每步原子持久化）。 */
async function applyPathStep(input: {
  vaultRoot: string;
  journal: FileOperationJournal;
  step: JournalPathStep;
  assetsDirectory: string;
}): Promise<FileOperationJournal> {
  const { vaultRoot, step, assetsDirectory } = input;
  let journal = input.journal;
  assertNotReservedPath(step.fromRelativePath, assetsDirectory);
  assertNotReservedPath(step.toRelativePath, assetsDirectory);
  if (
    step.kind === "group" &&
    isSelfOrDescendant(step.toRelativePath, step.fromRelativePath)
  ) {
    throw new IpcFailure(
      "INVALID_INPUT",
      "不能将分组移动到自身或其子目录中。",
    );
  }
  const fromAbs = await resolveWithinVault(vaultRoot, step.fromRelativePath);
  const toAbs = join(vaultRoot, ...step.toRelativePath.split("/"));
  await mkdir(dirname(toAbs), { recursive: true });
  if (!step.hopRelativePath && (await pathExists(toAbs))) {
    throw new IpcFailure(
      "VAULT_PATH_COLLISION",
      `目标路径已存在：${step.toRelativePath}`,
    );
  }

  const hopRel = step.hopRelativePath ?? null;
  journal = await updateJournalStep(vaultRoot, journal, {
    ...step,
    state: "intent",
    ...(hopRel ? { hopState: "to-hop-intent" as const } : {}),
  });
  try {
    if (hopRel) {
      const hopAbs = join(vaultRoot, ...hopRel.split("/"));
      await mkdir(dirname(hopAbs), { recursive: true });
      await fsRename(fromAbs, hopAbs);
      journal = await updateJournalStep(vaultRoot, journal, {
        ...step,
        state: "intent",
        hopState: "at-hop",
      });
      journal = await updateJournalStep(vaultRoot, journal, {
        ...step,
        state: "intent",
        hopState: "to-target-intent",
      });
      await fsRename(hopAbs, toAbs);
      journal = await updateJournalStep(vaultRoot, journal, {
        ...step,
        state: "applied",
        hopState: "at-target",
      });
    } else {
      await fsRename(fromAbs, toAbs);
      journal = await updateJournalStep(vaultRoot, journal, {
        ...step,
        state: "applied",
      });
    }
  } catch (error) {
    throw classifyFileOperationError(error);
  }
  return journal;
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

  // R11C-03：存在未完成/不可判定的 journal 时阻止危险写操作。
  const pendingScan = await listPendingJournals(vaultRoot);
  if (pendingScan.pending.length > 0 || pendingScan.unreadable.length > 0) {
    throw new IpcFailure(
      "FILE_OPERATION_RECOVERY_REQUIRED",
      "存在未完成或无法判定的文件操作日志，请先完成恢复后再执行文件操作。",
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

  // prepare 阶段即把 plan 的全部 path move 落进 journal（R11C-01）。
  const pathSteps: JournalPathStep[] = plan.pathMoves.map((move, index) => {
    const caseOnly = isCaseOnlyPathChange(
      move.fromRelativePath,
      move.toRelativePath,
    );
    return {
      id: `step-${index}`,
      kind: move.kind,
      fromRelativePath: move.fromRelativePath,
      toRelativePath: move.toRelativePath,
      hopRelativePath: caseOnly
        ? hopRelativePathFor(operationId, move.toRelativePath)
        : null,
      state: "pending",
      ...(caseOnly ? { hopState: "none" as const } : {}),
    };
  });
  let journal = await createJournal({
    vaultRoot,
    operationId,
    vaultId: plan.vaultId,
    kind: plan.kind,
    pathSteps,
  });

  let rewrittenLinks = 0;

  try {
    // 同一次操作内同一文件不重复备份。
    const backedUp = new Set<string>();
    for (const patch of plan.patches) {
      if (backedUp.has(patch.sourceRelativePathBefore)) continue;
      backedUp.add(patch.sourceRelativePathBefore);
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

    journal = await updateJournalPhase(vaultRoot, journal, "relocating");
    for (const step of journal.pathSteps) {
      journal = await applyPathStep({
        vaultRoot,
        journal,
        step,
        assetsDirectory,
      });
    }
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
      pathMoves: plan.pathMoves,
      rewrittenDocuments: plan.summary.rewrittenDocuments,
      rewrittenLinks,
    };
  } catch (error) {
    // 回滚本身失败时 rollbackJournal 抛出 RECOVERY_REQUIRED（journal 已
    // 保留为 recovery-required），恢复错误优先于原错误传播。
    await rollbackJournal({ vaultRoot, journal });
    if (error instanceof IpcFailure) throw error;
    throw classifyFileOperationError(error);
  }
}

interface StepRollbackOutcome {
  journal: FileOperationJournal;
  failed: { step: JournalPathStep; reason: string } | null;
}

/**
 * 单个 step 的回迁：结合 from/to/hop 实际存在状态判定（不猜测）。
 * 无法安全判定或回迁失败 → step 置 recovery-required 并记入 failed。
 */
async function rollbackPathStep(input: {
  vaultRoot: string;
  journal: FileOperationJournal;
  step: JournalPathStep;
}): Promise<StepRollbackOutcome> {
  const { vaultRoot, step } = input;
  let journal = input.journal;
  const fromAbs = join(vaultRoot, ...step.fromRelativePath.split("/"));
  const toAbs = join(vaultRoot, ...step.toRelativePath.split("/"));
  // case-only step 的 from/to 必须按目录项精确名判定（APFS 大小写不敏感）。
  const exists = step.hopRelativePath ? pathExistsExactName : pathExists;
  const fromExists = await exists(fromAbs);
  const toExists = await exists(toAbs);

  const fail = async (reason: string): Promise<StepRollbackOutcome> => {
    const failedStep: JournalPathStep = { ...step, state: "recovery-required" };
    journal = await updateJournalStep(vaultRoot, journal, failedStep);
    return { journal, failed: { step: failedStep, reason } };
  };

  const moveBack = async (sourceAbs: string): Promise<void> => {
    journal = await updateJournalStep(vaultRoot, journal, {
      ...step,
      state: "rollback-intent",
    });
    await mkdir(dirname(fromAbs), { recursive: true });
    await fsRename(sourceAbs, fromAbs);
  };

  try {
    if (step.hopRelativePath) {
      const hopAbs = join(vaultRoot, ...step.hopRelativePath.split("/"));
      const hopExists = await pathExists(hopAbs);
      if (hopExists) {
        // 数据停在中转跳：from/to 任一同时存在即无法安全判定。
        if (fromExists || toExists) {
          return fail("中转路径与源/目标同时存在，无法安全判定");
        }
        await moveBack(hopAbs);
      } else if (toExists) {
        // 第二跳已完成：to → from。
        if (fromExists) return fail("源与目标路径同时存在，无法安全判定");
        await moveBack(toAbs);
      } else if (fromExists) {
        // rename 未发生（crash before first rename）：无需回迁。
      } else {
        return fail("源/目标/中转路径均不存在，无法安全判定");
      }
    } else if (fromExists && !toExists) {
      // rename 未发生：无需回迁。
    } else if (!fromExists && toExists) {
      // rename 已发生：to → from。
      await moveBack(toAbs);
    } else {
      return fail("源与目标路径存在性无法安全判定");
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return fail(`路径回迁失败（${code ?? "IO"}）`);
  }
  journal = await updateJournalStep(vaultRoot, journal, {
    ...step,
    state: "rolled-back",
  });
  return { journal, failed: null };
}

/**
 * 回滚单个 journal：先路径回迁（逆序），再 restoreBackups 还原 Markdown。
 * 只有全部 step rolled-back 且 backup 还原完成才 removeJournal；
 * 任一失败 → phase=recovery-required、journal 保留、抛
 * FILE_OPERATION_RECOVERY_REQUIRED（details 只含相对路径诊断）。
 */
async function rollbackJournal(input: {
  vaultRoot: string;
  journal: FileOperationJournal;
}): Promise<void> {
  const { vaultRoot } = input;
  let journal = await updateJournalPhase(
    vaultRoot,
    input.journal,
    "rolling-back",
  );

  const failedSteps: {
    fromRelativePath: string;
    toRelativePath: string;
    reason: string;
  }[] = [];
  for (const step of [...journal.pathSteps].reverse()) {
    if (step.state === "rolled-back") continue;
    if (step.state === "recovery-required") {
      failedSteps.push({
        fromRelativePath: step.fromRelativePath,
        toRelativePath: step.toRelativePath,
        reason: "此前已标记需人工恢复",
      });
      continue;
    }
    const outcome = await rollbackPathStep({ vaultRoot, journal, step });
    journal = outcome.journal;
    if (outcome.failed) {
      failedSteps.push({
        fromRelativePath: step.fromRelativePath,
        toRelativePath: step.toRelativePath,
        reason: outcome.failed.reason,
      });
    }
  }

  let backupsRestored = true;
  try {
    await restoreBackups(vaultRoot, journal);
  } catch {
    backupsRestored = false;
  }

  if (failedSteps.length > 0 || !backupsRestored) {
    await updateJournalPhase(vaultRoot, journal, "recovery-required");
    throw new IpcFailure(
      "FILE_OPERATION_RECOVERY_REQUIRED",
      "文件操作回滚未能完成，请打开恢复详情后再继续。",
      {
        operationId: journal.operationId,
        failedSteps,
        backupsRestored,
      },
    );
  }

  await removeJournal(vaultRoot, journal.operationId);
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
  const scan = await listPendingJournals(input.vaultRoot);
  // R11C-03：corrupt / 不兼容版本的 journal 不得静默跳过。
  if (scan.unreadable.length > 0) {
    return {
      recovered: false,
      rolledBackOperationIds: [],
      manualRequired: true,
      message: "发现损坏或不兼容的文件操作日志，需要人工介入。",
    };
  }
  if (scan.pending.length === 0) {
    return {
      recovered: true,
      rolledBackOperationIds: [],
      manualRequired: false,
    };
  }

  const rolledBack: string[] = [];
  for (const journal of scan.pending) {
    try {
      await rollbackJournal({ vaultRoot: input.vaultRoot, journal });
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
