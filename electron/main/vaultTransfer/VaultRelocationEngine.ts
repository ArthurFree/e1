/**
 * R014 Stage 1–2：Missing Vault Relocate + Physical Vault Relocation。
 * journal 落 userData/vault-relocations/；绝对路径不出 IPC。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { IpcFailure } from "../../../shared/errors.js";
import {
  VAULT_RELOCATION_JOURNAL_VERSION,
  type RelocationJournalRead,
  type VaultRelocationJournal,
  type VaultRelocationPhase,
} from "../../../shared/vaultTransfer/journal.js";
import type {
  VaultRelocationStrategy,
  VaultTransferIssue,
  VaultTransferPlan,
  VaultTransferResult,
} from "../../../shared/vaultTransfer/types.js";
import { VAULT_TRANSFER_BLOCKER_CODES as CODES } from "../../../shared/vaultTransfer/types.js";
import { readVault } from "../filesystem/VaultFileSystem.js";
import type { VaultRegistry } from "../vaultRegistry.js";
import {
  copyDirectoryContents,
  fingerprintFiles,
  isEmptyDirectory,
  pathExists,
  removePath,
  verifyCopiedTrees,
  walkHashedFiles,
} from "./walkHash.js";

export interface RelocationFs {
  rename(from: string, to: string): Promise<void>;
}

const defaultFs: RelocationFs = { rename };

function isExdev(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EXDEV";
}

function isInside(parent: string, child: string): boolean {
  const p = resolve(parent) + sep;
  const c = resolve(child) + sep;
  return c.startsWith(p) && c !== p;
}

async function writeJournal(
  journalDir: string,
  journal: VaultRelocationJournal,
): Promise<void> {
  await mkdir(journalDir, { recursive: true });
  const file = join(journalDir, `${journal.operationId}.json`);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readRelocationJournalFile(
  file: string,
): Promise<RelocationJournalRead> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return { kind: "corrupt" };
  }
  if (!isRecord(parsed)) return { kind: "corrupt" };
  if (parsed.version !== VAULT_RELOCATION_JOURNAL_VERSION) {
    return { kind: "unsupported-version" };
  }
  if (
    typeof parsed.operationId !== "string" ||
    typeof parsed.vaultId !== "string" ||
    typeof parsed.sourcePath !== "string" ||
    typeof parsed.destinationPath !== "string" ||
    typeof parsed.phase !== "string" ||
    typeof parsed.sourceFingerprint !== "string"
  ) {
    return { kind: "corrupt" };
  }
  return { kind: "ok", journal: parsed as unknown as VaultRelocationJournal };
}

async function persistJournal(
  journalDir: string,
  journal: VaultRelocationJournal,
  patch: Partial<VaultRelocationJournal>,
): Promise<VaultRelocationJournal> {
  const next: VaultRelocationJournal = {
    ...journal,
    ...patch,
    updatedAt: nowIso(),
  };
  await writeJournal(journalDir, next);
  return next;
}

async function setPhase(
  journalDir: string,
  journal: VaultRelocationJournal,
  phase: VaultRelocationPhase,
): Promise<VaultRelocationJournal> {
  return persistJournal(journalDir, journal, { phase });
}

async function destMatchesMovedVault(
  journal: VaultRelocationJournal,
): Promise<boolean> {
  const read = await readVault(journal.destinationPath);
  if (read.status !== "initialized") return false;
  if (read.meta.vaultId !== journal.vaultId) return false;
  if (!journal.sourceFingerprint) return true;
  const files = await walkHashedFiles(journal.destinationPath);
  return fingerprintFiles(files) === journal.sourceFingerprint;
}

export function emptyTransferPlan(
  partial: Pick<
    VaultTransferPlan,
    "operationId" | "kind" | "sourceVaultId"
  > &
    Partial<VaultTransferPlan>,
): VaultTransferPlan {
  return {
    notes: [],
    directories: [],
    assets: [],
    revisions: [],
    linkImpacts: { internal: 0, inboundBoundary: 0, outboundBoundary: 0 },
    blockers: [],
    warnings: [],
    sourceFingerprint: "",
    destinationFingerprint: "",
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

export async function planRelocateMissing(input: {
  sourceVaultId: string;
  destinationAbsolutePath: string;
  registry: VaultRegistry;
}): Promise<VaultTransferPlan> {
  const operationId = randomUUID();
  const blockers: VaultTransferIssue[] = [];
  const record = await input.registry.findByVaultId(input.sourceVaultId);
  if (!record) {
    throw new IpcFailure(
      "VAULT_NOT_FOUND",
      "该知识库未在最近列表中登记，无法重新定位。",
    );
  }
  const stillThere = await pathExists(record.absolutePath);
  if (stillThere) {
    blockers.push({
      code: CODES.sourceAccessible,
      message: "原目录仍可访问，请改用「移动知识库位置」。",
    });
  }
  const dest = input.destinationAbsolutePath;
  if (!isAbsolute(dest)) {
    throw new IpcFailure("INVALID_INPUT", "重新定位目标必须是绝对路径（Main 内部）。");
  }
  const read = await readVault(dest);
  if (read.status !== "initialized") {
    blockers.push({
      code: "VAULT_NOT_INITIALIZED",
      message: "所选目录不是已初始化的 E1 知识库。",
    });
  } else if (read.meta.vaultId !== input.sourceVaultId) {
    blockers.push({
      code: CODES.vaultIdMismatch,
      message: "所选知识库与原记录不是同一个库（vaultId 不一致）。",
    });
  }
  const destFiles = read.status === "initialized" ? await walkHashedFiles(dest) : [];
  return emptyTransferPlan({
    operationId,
    kind: "relocate-missing",
    sourceVaultId: input.sourceVaultId,
    destinationVaultId: input.sourceVaultId,
    blockers,
    sourceFingerprint: record.absolutePath,
    destinationFingerprint: fingerprintFiles(destFiles),
  });
}

export async function executeRelocateMissing(input: {
  plan: VaultTransferPlan;
  destinationAbsolutePath: string;
  registry: VaultRegistry;
}): Promise<VaultTransferResult> {
  if (input.plan.blockers.length > 0) {
    throw new IpcFailure(
      "INVALID_INPUT",
      input.plan.blockers[0]?.message ?? "无法重新定位",
    );
  }
  const replay = await planRelocateMissing({
    sourceVaultId: input.plan.sourceVaultId,
    destinationAbsolutePath: input.destinationAbsolutePath,
    registry: input.registry,
  });
  if (replay.destinationFingerprint !== input.plan.destinationFingerprint) {
    throw new IpcFailure(
      "VAULT_TRANSFER_STALE_PLAN",
      "目标目录在预检后已变化，请重新定位。",
    );
  }
  if (replay.blockers.length > 0) {
    throw new IpcFailure(
      "VAULT_TRANSFER_STALE_PLAN",
      replay.blockers[0]?.message ?? "预检已过期",
    );
  }
  await input.registry.updateAbsolutePath(
    input.plan.sourceVaultId,
    input.destinationAbsolutePath,
    basename(input.destinationAbsolutePath),
  );
  return {
    operationId: input.plan.operationId,
    kind: "relocate-missing",
    sourceVaultId: input.plan.sourceVaultId,
    destinationVaultId: input.plan.sourceVaultId,
    notesCopied: 0,
    assetsCopied: 0,
    revisionsTransferred: 0,
    sourceTrashed: false,
  };
}

export async function planRelocateVault(input: {
  sourceVaultId: string;
  destinationParentAbsolutePath: string;
  newFolderName: string;
  registry: VaultRegistry;
}): Promise<VaultTransferPlan> {
  const operationId = randomUUID();
  const blockers: VaultTransferIssue[] = [];
  const record = await input.registry.findByVaultId(input.sourceVaultId);
  if (!record) {
    throw new IpcFailure("VAULT_NOT_FOUND", "该知识库未登记。");
  }
  if (!(await pathExists(record.absolutePath))) {
    blockers.push({
      code: "VAULT_NOT_FOUND",
      message: "原目录不可访问，请改用「重新定位知识库」。",
    });
  }
  const dest = join(input.destinationParentAbsolutePath, input.newFolderName);
  if (resolve(dest) === resolve(record.absolutePath)) {
    blockers.push({
      code: CODES.destSameVault,
      message: "目标位置与当前位置相同。",
    });
  }
  if (isInside(record.absolutePath, dest)) {
    blockers.push({
      code: CODES.destInsideSource,
      message: "不能把知识库移动到自己内部。",
    });
  }
  if (await pathExists(dest)) {
    const empty = await isEmptyDirectory(dest);
    if (!empty) {
      blockers.push({
        code: CODES.destNotEmpty,
        message: "目标文件夹已存在且非空，拒绝覆盖。",
      });
    }
  }
  const sourceFiles = await pathExists(record.absolutePath)
    ? await walkHashedFiles(record.absolutePath)
    : [];
  return emptyTransferPlan({
    operationId,
    kind: "relocate-vault",
    sourceVaultId: input.sourceVaultId,
    destinationVaultId: input.sourceVaultId,
    newFolderName: input.newFolderName,
    blockers,
    strategy: "rename",
    sourceFingerprint: fingerprintFiles(sourceFiles),
    destinationFingerprint: dest,
  });
}

export async function executeRelocateVault(input: {
  plan: VaultTransferPlan;
  destinationParentAbsolutePath: string;
  journalDir: string;
  registry: VaultRegistry;
  onRootChanged?: (vaultId: string, absolutePath: string) => Promise<void>;
  fs?: RelocationFs;
}): Promise<VaultTransferResult> {
  if (input.plan.blockers.length > 0) {
    throw new IpcFailure(
      "INVALID_INPUT",
      input.plan.blockers[0]?.message ?? "无法移动知识库",
    );
  }
  const record = await input.registry.findByVaultId(input.plan.sourceVaultId);
  if (!record) throw new IpcFailure("VAULT_NOT_FOUND", "该知识库未登记。");
  const dest = join(
    input.destinationParentAbsolutePath,
    input.plan.newFolderName ?? basename(record.absolutePath),
  );
  const replay = await planRelocateVault({
    sourceVaultId: input.plan.sourceVaultId,
    destinationParentAbsolutePath: input.destinationParentAbsolutePath,
    newFolderName: input.plan.newFolderName ?? basename(record.absolutePath),
    registry: input.registry,
  });
  if (replay.sourceFingerprint !== input.plan.sourceFingerprint) {
    throw new IpcFailure(
      "VAULT_TRANSFER_STALE_PLAN",
      "源知识库在预检后已变化，请重新计划。",
    );
  }
  if (replay.destinationFingerprint !== dest) {
    throw new IpcFailure(
      "VAULT_TRANSFER_STALE_PLAN",
      "目标位置在预检后已变化，请重新计划。",
    );
  }
  if (replay.blockers.length > 0) {
    throw new IpcFailure(
      "VAULT_TRANSFER_STALE_PLAN",
      replay.blockers[0]?.message ?? "预检已过期",
    );
  }

  const fs = input.fs ?? defaultFs;
  const createdAt = nowIso();
  let journal: VaultRelocationJournal = {
    version: VAULT_RELOCATION_JOURNAL_VERSION,
    operationId: input.plan.operationId,
    vaultId: input.plan.sourceVaultId,
    sourcePath: record.absolutePath,
    destinationPath: dest,
    strategy: "rename",
    phase: "prepared",
    sourceFingerprint: input.plan.sourceFingerprint,
    createdAt,
    updatedAt: createdAt,
  };
  await writeJournal(input.journalDir, journal);

  let strategy: VaultRelocationStrategy = "rename";
  journal = await persistJournal(input.journalDir, journal, {
    phase: "rename-intent",
  });
  try {
    if (await pathExists(dest) && (await isEmptyDirectory(dest))) {
      await removePath(dest);
    }
    await fs.rename(record.absolutePath, dest);
    journal = await persistJournal(input.journalDir, journal, {
      phase: "rename-applied",
      strategy: "rename",
    });
  } catch (error) {
    if (!isExdev(error)) throw error;
    strategy = "copy-verify-delete";
    journal = await persistJournal(input.journalDir, journal, {
      strategy,
      phase: "copying",
    });
    const staging = `${dest}.e1-relocating`;
    await removePath(staging);
    await copyDirectoryContents(record.absolutePath, staging);
    journal = await setPhase(input.journalDir, journal, "verifying");
    const srcFiles = await walkHashedFiles(record.absolutePath);
    const dstFiles = await walkHashedFiles(staging);
    const mismatches = verifyCopiedTrees(srcFiles, dstFiles);
    if (mismatches.length > 0) {
      await removePath(staging);
      await setPhase(input.journalDir, journal, "recovery-required");
      throw new IpcFailure(
        "VAULT_TRANSFER_PARTIAL_FAILURE",
        `跨卷复制校验失败：${mismatches[0]}`,
      );
    }
    if (await pathExists(dest) && (await isEmptyDirectory(dest))) {
      await removePath(dest);
    }
    await fs.rename(staging, dest);
    journal = await persistJournal(input.journalDir, journal, {
      phase: "destination-ready",
      destinationFingerprint: fingerprintFiles(dstFiles),
    });
  }

  journal = await persistJournal(input.journalDir, journal, {
    strategy,
    phase: "registry-updating",
  });
  await input.registry.updateAbsolutePath(
    input.plan.sourceVaultId,
    dest,
    basename(dest),
  );
  journal = await setPhase(input.journalDir, journal, "registry-updated");
  await input.onRootChanged?.(input.plan.sourceVaultId, dest);

  if (strategy === "copy-verify-delete") {
    journal = await setPhase(input.journalDir, journal, "source-removing");
    await removePath(record.absolutePath);
  }
  journal = await setPhase(input.journalDir, journal, "committed");
  await rm(join(input.journalDir, `${journal.operationId}.json`), {
    force: true,
  });

  return {
    operationId: input.plan.operationId,
    kind: "relocate-vault",
    sourceVaultId: input.plan.sourceVaultId,
    destinationVaultId: input.plan.sourceVaultId,
    notesCopied: 0,
    assetsCopied: 0,
    revisionsTransferred: 0,
    sourceTrashed: false,
  };
}

export type RelocationInspectItem = {
  operationId: string;
  fileName: string;
  classification: "recoverable" | "manual-required";
  action?: RelocationRecoverAction;
  reason?: string;
};

export type RelocationRecoverAction =
  | "abort-prepared"
  | "abort-rename"
  | "complete-rename"
  | "abort-copy"
  | "finish-registry"
  | "commit-cleanup";

export async function inspectRelocations(input: {
  journalDir: string;
}): Promise<{
  recoverable: RelocationInspectItem[];
  manual: RelocationInspectItem[];
}> {
  const recoverable: RelocationInspectItem[] = [];
  const manual: RelocationInspectItem[] = [];
  let names: string[];
  try {
    names = await readdir(input.journalDir);
  } catch {
    return { recoverable, manual };
  }
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".tmp")) continue;
    const read = await readRelocationJournalFile(join(input.journalDir, name));
    if (read.kind !== "ok") {
      manual.push({
        operationId: name.replace(/\.json$/, ""),
        fileName: name,
        classification: "manual-required",
        reason:
          read.kind === "unsupported-version"
            ? "不支持的搬迁 journal 版本，未自动迁移。"
            : "搬迁 journal 损坏，无法判定。",
      });
      continue;
    }
    const item = await classifyRelocation(read.journal, name);
    if (item.classification === "recoverable") recoverable.push(item);
    else manual.push(item);
  }
  return { recoverable, manual };
}

async function classifyRelocation(
  journal: VaultRelocationJournal,
  fileName: string,
): Promise<RelocationInspectItem> {
  const sourceExists = await pathExists(journal.sourcePath);
  const destExists = await pathExists(journal.destinationPath);
  const destValid = destExists ? await destMatchesMovedVault(journal) : false;
  const base = { operationId: journal.operationId, fileName };

  const manual = (reason: string): RelocationInspectItem => ({
    ...base,
    classification: "manual-required",
    reason,
  });
  const recoverable = (action: RelocationRecoverAction): RelocationInspectItem => ({
    ...base,
    classification: "recoverable",
    action,
  });

  switch (journal.phase) {
    case "prepared":
      if (sourceExists && !destExists) return recoverable("abort-prepared");
      return manual("prepared 阶段文件系统状态与 journal 不一致。");
    case "rename-intent":
      if (sourceExists && !destExists) return recoverable("abort-rename");
      if (!sourceExists && destExists && destValid) {
        return recoverable("complete-rename");
      }
      return manual("rename-intent 阶段源与目标同时存在或同时缺失。");
    case "rename-applied":
      if (!sourceExists && destExists && destValid) {
        return recoverable("complete-rename");
      }
      return manual("rename-applied 阶段无法证明目标是本次搬迁结果。");
    case "copying":
    case "verifying":
      if (sourceExists) return recoverable("abort-copy");
      return manual("复制中断且源目录已不存在，需要人工确认。");
    case "destination-ready":
    case "registry-updating":
      if (destExists && destValid && !sourceExists) {
        return recoverable("finish-registry");
      }
      if (
        destExists &&
        destValid &&
        sourceExists &&
        journal.strategy === "copy-verify-delete"
      ) {
        return recoverable("finish-registry");
      }
      return manual("目标已就绪但无法安全判定下一步。");
    case "registry-updated":
      if (journal.strategy === "copy-verify-delete" && sourceExists) {
        return manual("Registry 已更新但源目录仍在，未自动删除源。");
      }
      return recoverable("commit-cleanup");
    case "source-removing":
      if (sourceExists) {
        return manual("正在删除源目录时中断，未自动删除。");
      }
      return recoverable("commit-cleanup");
    case "committed":
      return recoverable("commit-cleanup");
    case "recovery-required":
      return manual("journal 标记为需要人工恢复。");
    default:
      return manual(`未知 phase：${String(journal.phase)}`);
  }
}

export async function recoverRelocations(input: {
  journalDir: string;
  registry: VaultRegistry;
  onRootChanged?: (vaultId: string, absolutePath: string) => Promise<void>;
}): Promise<{ recovered: string[]; manual: string[] }> {
  const inspected = await inspectRelocations({ journalDir: input.journalDir });
  const recovered: string[] = [];
  const manual = inspected.manual.map((item) => item.operationId);

  for (const item of inspected.recoverable) {
    const file = join(input.journalDir, item.fileName);
    const read = await readRelocationJournalFile(file);
    if (read.kind !== "ok") {
      manual.push(item.operationId);
      continue;
    }
    const journal = read.journal;
    const staging = `${journal.destinationPath}.e1-relocating`;
    try {
      switch (item.action) {
        case "abort-prepared":
        case "abort-rename":
          await rm(file, { force: true });
          recovered.push(journal.operationId);
          break;
        case "abort-copy":
          await removePath(staging);
          await rm(file, { force: true });
          recovered.push(journal.operationId);
          break;
        case "complete-rename":
        case "finish-registry":
          await input.registry.updateAbsolutePath(
            journal.vaultId,
            journal.destinationPath,
            basename(journal.destinationPath),
          );
          await input.onRootChanged?.(journal.vaultId, journal.destinationPath);
          if (
            journal.strategy === "copy-verify-delete" &&
            (await pathExists(journal.sourcePath))
          ) {
            await persistJournal(input.journalDir, journal, {
              phase: "registry-updated",
            });
            manual.push(journal.operationId);
            break;
          }
          await rm(file, { force: true });
          recovered.push(journal.operationId);
          break;
        case "commit-cleanup":
          await rm(file, { force: true });
          recovered.push(journal.operationId);
          break;
        default:
          manual.push(journal.operationId);
      }
    } catch {
      manual.push(journal.operationId);
    }
  }
  return { recovered, manual };
}

export function relocationJournalDir(userDataDir: string): string {
  return join(userDataDir, "vault-relocations");
}
