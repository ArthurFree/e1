/**
 * R011.1（R11C-01~05）：文件操作 journal v2——`.e1/operations/<operationId>/`。
 * manifest 经临时文件 + rename 原子写；backup/ 存放将被 patch 的原文。
 *
 * - 读取结果显式分类（JournalReadResult）：corrupt / unsupported-version
 *   不得静默忽略，必须进入 FILE_OPERATION_RECOVERY_REQUIRED；
 * - backup 命名 `backup/<sha256(relativePath)前16位>/<basename>` 防碰撞；
 * - v1 journal 不迁移（version!==2 → unsupported-version）。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IpcFailure } from "../../../shared/errors.js";
import {
  FILE_OPERATION_JOURNAL_VERSION,
  type FileOperationJournal,
  type FileOperationJournalPhase,
  type JournalPathStep,
} from "../../../shared/fileOperations/journal.js";
import type { FileOperationKind } from "../../../shared/fileOperations/types.js";

const OPERATIONS_DIR = join(".e1", "operations");

export function operationsRoot(vaultRoot: string): string {
  return join(vaultRoot, OPERATIONS_DIR);
}

export function journalDir(vaultRoot: string, operationId: string): string {
  return join(operationsRoot(vaultRoot), operationId);
}

/** 原子写 JSON（同目录 temp + rename）。 */
export async function atomicWriteJson(
  targetPath: string,
  value: unknown,
): Promise<void> {
  const dir = join(targetPath, "..");
  await mkdir(dir, { recursive: true });
  const tmp = `${targetPath}.e1-tmp-${process.pid}-${Date.now().toString(36)}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, targetPath);
}

export async function createJournal(input: {
  vaultRoot: string;
  operationId: string;
  vaultId: string;
  kind: FileOperationKind;
  pathSteps: JournalPathStep[];
}): Promise<FileOperationJournal> {
  const dir = journalDir(input.vaultRoot, input.operationId);
  await mkdir(join(dir, "backup"), { recursive: true });
  const journal: FileOperationJournal = {
    version: FILE_OPERATION_JOURNAL_VERSION,
    operationId: input.operationId,
    vaultId: input.vaultId,
    kind: input.kind,
    phase: "prepared",
    backups: [],
    pathSteps: input.pathSteps,
    createdAt: new Date().toISOString(),
  };
  await atomicWriteJson(join(dir, "manifest.json"), journal);
  return journal;
}

/** journal 读取结果显式分类（R11C-03：corrupt/旧版本不得静默忽略）。 */
export type JournalReadResult =
  | { kind: "ok"; journal: FileOperationJournal }
  | { kind: "missing" }
  | { kind: "corrupt"; reason: string }
  | { kind: "unsupported-version"; version: number };

function isJournalShapeV2(value: unknown): value is FileOperationJournal {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.operationId === "string" &&
    typeof v.vaultId === "string" &&
    typeof v.phase === "string" &&
    Array.isArray(v.backups) &&
    Array.isArray(v.pathSteps)
  );
}

export async function readJournal(
  vaultRoot: string,
  operationId: string,
): Promise<JournalReadResult> {
  let raw: string;
  try {
    raw = await readFile(
      join(journalDir(vaultRoot, operationId), "manifest.json"),
      "utf8",
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    return { kind: "corrupt", reason: `manifest 读取失败（${code ?? "IO"}）` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt", reason: "manifest 不是合法 JSON" };
  }
  const version =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>).version
      : undefined;
  if (typeof version === "number" && version !== FILE_OPERATION_JOURNAL_VERSION) {
    return { kind: "unsupported-version", version };
  }
  if (version !== FILE_OPERATION_JOURNAL_VERSION || !isJournalShapeV2(parsed)) {
    return { kind: "corrupt", reason: "manifest 结构不符合 journal v2" };
  }
  return { kind: "ok", journal: parsed };
}

export async function updateJournalPhase(
  vaultRoot: string,
  journal: FileOperationJournal,
  phase: FileOperationJournalPhase,
  patch?: Partial<FileOperationJournal>,
): Promise<FileOperationJournal> {
  const next: FileOperationJournal = { ...journal, ...patch, phase };
  await atomicWriteJson(
    join(journalDir(vaultRoot, journal.operationId), "manifest.json"),
    next,
  );
  return next;
}

/** 逐 move 状态翻转落盘（R11C-01：intent/applied 每步原子持久化）。 */
export async function updateJournalStep(
  vaultRoot: string,
  journal: FileOperationJournal,
  nextStep: JournalPathStep,
): Promise<FileOperationJournal> {
  const next: FileOperationJournal = {
    ...journal,
    pathSteps: journal.pathSteps.map((s) =>
      s.id === nextStep.id ? nextStep : s,
    ),
  };
  await atomicWriteJson(
    join(journalDir(vaultRoot, journal.operationId), "manifest.json"),
    next,
  );
  return next;
}

/**
 * 将 vault 相对路径文件备份进 journal/backup/，返回 journal 内相对路径。
 * 命名为 `backup/<sha256(originalRelativePath)前16位>/<basename>`，
 * 避免 `a/b.md` 与 `a__b.md` 之类的扁平化碰撞（R11C-05）。
 */
export async function backupFile(input: {
  vaultRoot: string;
  operationId: string;
  originalRelativePath: string;
  versionToken: string;
}): Promise<{ backupRelativePath: string }> {
  const digest = createHash("sha256")
    .update(input.originalRelativePath)
    .digest("hex")
    .slice(0, 16);
  const basename = input.originalRelativePath.split("/").pop()!;
  const backupRelativePath = `backup/${digest}/${basename}`;
  const src = join(input.vaultRoot, ...input.originalRelativePath.split("/"));
  const dest = join(
    journalDir(input.vaultRoot, input.operationId),
    backupRelativePath,
  );
  await mkdir(join(dest, ".."), { recursive: true });
  const bytes = await readFile(src);
  await writeFile(dest, bytes);
  return { backupRelativePath };
}

export async function restoreBackups(
  vaultRoot: string,
  journal: FileOperationJournal,
): Promise<void> {
  for (const backup of journal.backups) {
    const src = join(
      journalDir(vaultRoot, journal.operationId),
      backup.backupRelativePath,
    );
    const dest = join(vaultRoot, ...backup.originalRelativePath.split("/"));
    await mkdir(join(dest, ".."), { recursive: true });
    const bytes = await readFile(src);
    await writeFile(dest, bytes);
  }
}

export async function removeJournal(
  vaultRoot: string,
  operationId: string,
): Promise<void> {
  await rm(journalDir(vaultRoot, operationId), {
    recursive: true,
    force: true,
  });
}

/** operations 目录扫描结果：pending journal + 无法自动判定的条目。 */
export interface PendingJournalScan {
  pending: FileOperationJournal[];
  /** corrupt / unsupported-version 的 journal（不得静默跳过）。 */
  unreadable: { operationId: string; reason: string }[];
}

/** 列出非 committed 的 journal（crash recovery 扫描）。 */
export async function listPendingJournals(
  vaultRoot: string,
): Promise<PendingJournalScan> {
  const root = operationsRoot(vaultRoot);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return { pending: [], unreadable: [] };
  }
  const result: PendingJournalScan = { pending: [], unreadable: [] };
  for (const name of names) {
    const read = await readJournal(vaultRoot, name);
    if (read.kind === "missing") continue;
    if (read.kind === "corrupt") {
      result.unreadable.push({ operationId: name, reason: read.reason });
      continue;
    }
    if (read.kind === "unsupported-version") {
      result.unreadable.push({
        operationId: name,
        reason: `不支持的 journal 版本：${read.version}`,
      });
      continue;
    }
    if (read.journal.phase === "committed") continue;
    result.pending.push(read.journal);
  }
  return result;
}

/** 读到的 journal 必须为 v2 正常形态，否则视为需要人工恢复。 */
export function assertJournalCompatible(
  result: JournalReadResult,
): asserts result is { kind: "ok"; journal: FileOperationJournal } {
  if (result.kind !== "ok") {
    throw new IpcFailure(
      "FILE_OPERATION_RECOVERY_REQUIRED",
      "发现无法自动判定的文件操作日志，请打开恢复详情后再继续写入。",
    );
  }
}
