/**
 * R014 Stage 1–2：Missing Vault Relocate + Physical Vault Relocation。
 * journal 落 userData/vault-relocations/；绝对路径不出 IPC。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { IpcFailure } from "../../../shared/errors.js";
import {
  VAULT_RELOCATION_JOURNAL_VERSION,
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

async function readJournalFile(
  file: string,
): Promise<VaultRelocationJournal | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as VaultRelocationJournal).version !==
        VAULT_RELOCATION_JOURNAL_VERSION
    ) {
      return null;
    }
    return parsed as VaultRelocationJournal;
  } catch {
    return null;
  }
}

async function setPhase(
  journalDir: string,
  journal: VaultRelocationJournal,
  phase: VaultRelocationPhase,
): Promise<VaultRelocationJournal> {
  const next = { ...journal, phase };
  await writeJournal(journalDir, next);
  return next;
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
  let journal: VaultRelocationJournal = {
    version: VAULT_RELOCATION_JOURNAL_VERSION,
    operationId: input.plan.operationId,
    vaultId: input.plan.sourceVaultId,
    sourcePath: record.absolutePath,
    destinationPath: dest,
    strategy: "rename",
    phase: "prepared",
    createdAt: new Date().toISOString(),
  };
  await writeJournal(input.journalDir, journal);

  let strategy: VaultRelocationStrategy = "rename";
  try {
    if (await pathExists(dest) && (await isEmptyDirectory(dest))) {
      await removePath(dest);
    }
    await fs.rename(record.absolutePath, dest);
  } catch (error) {
    if (!isExdev(error)) throw error;
    strategy = "copy-verify-delete";
    journal = {
      ...journal,
      strategy,
      phase: "copying",
    };
    await writeJournal(input.journalDir, journal);
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
    if (await pathExists(dest)) await removePath(dest);
    await fs.rename(staging, dest);
    journal = await setPhase(input.journalDir, journal, "destination-ready");
  }

  journal = {
    ...journal,
    strategy,
    phase: "registry-updated",
  };
  await writeJournal(input.journalDir, journal);
  await input.registry.updateAbsolutePath(
    input.plan.sourceVaultId,
    dest,
    basename(dest),
  );
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

export async function recoverRelocations(input: {
  journalDir: string;
  registry: VaultRegistry;
  onRootChanged?: (vaultId: string, absolutePath: string) => Promise<void>;
}): Promise<{ recovered: string[]; manual: string[] }> {
  const recovered: string[] = [];
  const manual: string[] = [];
  let names: string[];
  try {
    const { readdir } = await import("node:fs/promises");
    names = await readdir(input.journalDir);
  } catch {
    return { recovered, manual };
  }
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".tmp")) continue;
    const journal = await readJournalFile(join(input.journalDir, name));
    if (!journal) {
      manual.push(name);
      continue;
    }
    const staging = `${journal.destinationPath}.e1-relocating`;
    if (
      journal.phase === "prepared" ||
      journal.phase === "copying" ||
      journal.phase === "verifying"
    ) {
      await removePath(staging);
      await rm(join(input.journalDir, name), { force: true });
      recovered.push(journal.operationId);
      continue;
    }
    if (
      journal.phase === "destination-ready" ||
      journal.phase === "registry-updated"
    ) {
      if (await pathExists(journal.destinationPath)) {
        await input.registry.updateAbsolutePath(
          journal.vaultId,
          journal.destinationPath,
          basename(journal.destinationPath),
        );
        await input.onRootChanged?.(journal.vaultId, journal.destinationPath);
      }
      if (
        journal.strategy === "copy-verify-delete" &&
        journal.phase === "registry-updated" &&
        (await pathExists(journal.sourcePath))
      ) {
        // 源仍在：不猜测删除。
        manual.push(journal.operationId);
        continue;
      }
      await rm(join(input.journalDir, name), { force: true });
      recovered.push(journal.operationId);
      continue;
    }
    if (journal.phase === "source-removing") {
      if (await pathExists(journal.sourcePath)) {
        manual.push(journal.operationId);
        continue;
      }
      await rm(join(input.journalDir, name), { force: true });
      recovered.push(journal.operationId);
      continue;
    }
    if (journal.phase === "committed") {
      await rm(join(input.journalDir, name), { force: true });
      recovered.push(journal.operationId);
      continue;
    }
    manual.push(journal.operationId);
  }
  return { recovered, manual };
}

export function relocationJournalDir(userDataDir: string): string {
  return join(userDataDir, "vault-relocations");
}
