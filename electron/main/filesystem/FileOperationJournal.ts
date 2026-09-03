/**
 * R011 Stage 2：文件操作 journal——`.e1/operations/<operationId>/`。
 * manifest 经临时文件 + rename 原子写；backup/ 存放将被 patch 的原文。
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IpcFailure } from "../../../shared/errors.js";
import {
  FILE_OPERATION_JOURNAL_VERSION,
  type FileOperationJournal,
  type FileOperationJournalPhase,
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
  fromRelativePath: string | null;
  toRelativePath: string | null;
}): Promise<FileOperationJournal> {
  const dir = journalDir(input.vaultRoot, input.operationId);
  await mkdir(join(dir, "backup"), { recursive: true });
  const journal: FileOperationJournal = {
    version: FILE_OPERATION_JOURNAL_VERSION,
    operationId: input.operationId,
    vaultId: input.vaultId,
    kind: input.kind,
    phase: "prepared",
    fromRelativePath: input.fromRelativePath,
    toRelativePath: input.toRelativePath,
    backups: [],
    createdAt: new Date().toISOString(),
  };
  await atomicWriteJson(join(dir, "manifest.json"), journal);
  return journal;
}

export async function readJournal(
  vaultRoot: string,
  operationId: string,
): Promise<FileOperationJournal | null> {
  try {
    const raw = await readFile(
      join(journalDir(vaultRoot, operationId), "manifest.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as FileOperationJournal;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
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

/** 将 vault 相对路径文件备份进 journal/backup/，返回 journal 内相对路径。 */
export async function backupFile(input: {
  vaultRoot: string;
  operationId: string;
  originalRelativePath: string;
  versionToken: string;
}): Promise<{ backupRelativePath: string }> {
  const safeName = input.originalRelativePath.replaceAll("/", "__");
  const backupRelativePath = `backup/${safeName}`;
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

/** 列出非 committed 的 journal（crash recovery 扫描）。 */
export async function listPendingJournals(
  vaultRoot: string,
): Promise<FileOperationJournal[]> {
  const root = operationsRoot(vaultRoot);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const pending: FileOperationJournal[] = [];
  for (const name of names) {
    const journal = await readJournal(vaultRoot, name);
    if (!journal) continue;
    if (journal.phase === "committed") continue;
    pending.push(journal);
  }
  return pending;
}

export function assertJournalCompatible(
  journal: FileOperationJournal | null,
): asserts journal is FileOperationJournal {
  if (!journal || journal.version !== 1) {
    throw new IpcFailure(
      "FILE_OPERATION_RECOVERY_REQUIRED",
      "发现无法自动判定的文件操作日志，请打开恢复详情后再继续写入。",
    );
  }
}
