/**
 * R007 阶段 4（§4.2）：Vault 回收站文件系统。
 *
 * 布局（规格锁定）：
 *   .e1/trash/<operationId>/
 *   ├── payload/...    被删除的文件或目录（rename 移入，绝不 unlink）
 *   └── meta.json      { version: 1, deletedAt, originalRelativePath, stableNoteId? }
 *
 * 语义：
 * - 删除 = rename/move 进 trash（同卷 rename 原子，不丢内容）；
 * - 恢复 = 还原到 originalRelativePath；原父目录缺失时递归重建；目标已被
 *   占用时确定性改名恢复（"name (2).ext" 递增，与 markdownFileName 同形态）；
 * - 永久删除（purge）才物理删除；
 * - stableNoteId 仅从 .md 文件的 Frontmatter 头部解析（复用 shared 的
 *   splitFrontmatter，与扫描器同口径）；目录与无 id 文档省略该字段；
 * - .e1/trash 以点开头，扫描器天然跳过，回收站内容不会进页面树；
 *   watcher 同样忽略 .e1 内变化（purge 无需自写登记）。
 */
import { randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename as fsRename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { IpcFailure } from "../../../shared/errors.js";
import type { TrashEntry } from "../../../shared/ipc/contracts.js";
import { splitFrontmatter } from "../../../shared/markdown/frontmatter.js";
import { resolveWithinVault } from "./PathGuard.js";
import {
  assertNotReservedPath,
  classifyFileOperationError,
  nameForAttempt,
  pathExists,
  resolveAssetsDirectory,
  toPosixRelative,
} from "./VaultFileOperations.js";

/** .e1 内回收站目录名。 */
const TRASH_DIR = join(".e1", "trash");

/** 只读 Frontmatter 头部长度（与 VaultFileSystem 扫描口径一致）。 */
const FRONTMATTER_HEAD_BYTES = 8192;

/** 冲突递增上限（防异常死循环，与既有写路径同口径）。 */
const MAX_ATTEMPTS = 10_000;

/** operationId 线格式：<base36 时间戳>-<12 hex>；入站校验用同一形态防路径注入。 */
const OPERATION_ID_PATTERN = /^[a-z0-9]+-[0-9a-f]{12}$/i;

/** meta.json 的磁盘形状（version 1）。 */
interface TrashMeta {
  deletedAt: string;
  originalRelativePath: string;
  stableNoteId?: string;
}

function newOperationId(): string {
  return `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
}

/**
 * operationId → trash 条目目录。格式非法（含分隔符/.. 等）直接拒绝——
 * operationId 只由本模块生成，外来形态一律视为调用方错误。
 */
function resolveTrashOpDir(vaultRoot: string, operationId: string): string {
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new IpcFailure(
      "INVALID_INPUT",
      `非法的回收站 operationId：${operationId}`,
    );
  }
  return join(vaultRoot, TRASH_DIR, operationId);
}

/** meta.json 原子写（tmp + rename，与 DesktopVaultStateStore 同口径）。 */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsRename(tmp, path);
}

/** 读取并校验 meta.json；缺失/损坏返回 null（容错跳过，不阻断列表）。 */
async function readTrashMeta(opDir: string): Promise<TrashMeta | null> {
  let raw: string;
  try {
    raw = await readFile(join(opDir, "meta.json"), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.originalRelativePath !== "string" ||
      record.originalRelativePath.trim() === "" ||
      typeof record.deletedAt !== "string" ||
      record.deletedAt.trim() === ""
    ) {
      return null;
    }
    const meta: TrashMeta = {
      deletedAt: record.deletedAt,
      originalRelativePath: record.originalRelativePath,
    };
    if (
      typeof record.stableNoteId === "string" &&
      record.stableNoteId.trim() !== ""
    ) {
      meta.stableNoteId = record.stableNoteId;
    }
    return meta;
  } catch {
    return null;
  }
}

/** 只读文件头部提取 Frontmatter stable id；任何失败按「无 id」处理（省略字段）。 */
async function readStableNoteId(
  absolutePath: string,
): Promise<string | undefined> {
  try {
    const handle = await open(absolutePath, "r");
    let head: string;
    try {
      const buffer = Buffer.alloc(FRONTMATTER_HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      head = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    const { metadata } = splitFrontmatter(head.replace(/\r\n/g, "\n"));
    return metadata.id ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 移入回收站（删除的唯一入口——rename 进 .e1/trash，绝不 unlink）。
 * 文件与目录均支持；保留区（.e1/assets）拒绝。
 * @throws IpcFailure NOTE_NOT_FOUND / VAULT_RESERVED_PATH / NOTE_WRITE_*
 */
export async function trashEntry(input: {
  vaultRoot: string;
  relativePath: string;
}): Promise<{ operationId: string }> {
  const assetsDirectory = await resolveAssetsDirectory(input.vaultRoot);
  assertNotReservedPath(input.relativePath, assetsDirectory);
  const sourceAbs = await resolveWithinVault(
    input.vaultRoot,
    input.relativePath,
  );
  const sourceStats = await stat(sourceAbs);

  const operationId = newOperationId();
  const opDir = join(input.vaultRoot, TRASH_DIR, operationId);
  const payloadDir = join(opDir, "payload");
  await mkdir(payloadDir, { recursive: true });

  const payloadAbs = join(payloadDir, basename(sourceAbs));
  try {
    await fsRename(sourceAbs, payloadAbs);
  } catch (error) {
    // 移动失败不留半成品条目目录。
    await rm(opDir, { recursive: true, force: true }).catch(() => {});
    throw classifyFileOperationError(error);
  }

  // stableNoteId：仅 .md 文件尝试解析（目录/无 id 文档省略）。
  let stableNoteId: string | undefined;
  if (sourceStats.isFile() && /\.md$/i.test(basename(sourceAbs))) {
    stableNoteId = await readStableNoteId(payloadAbs);
  }
  const meta = {
    version: 1,
    deletedAt: new Date().toISOString(),
    originalRelativePath: input.relativePath,
    ...(stableNoteId ? { stableNoteId } : {}),
  };
  await writeJsonAtomic(join(opDir, "meta.json"), meta);
  return { operationId };
}

/** 列出回收站条目（deletedAt 倒序）；trash 目录不存在时为空表。 */
export async function listTrashEntries(input: {
  vaultRoot: string;
}): Promise<TrashEntry[]> {
  const trashRoot = join(input.vaultRoot, TRASH_DIR);
  let dirents;
  try {
    dirents = await readdir(trashRoot, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw classifyFileOperationError(error);
  }
  const entries: TrashEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || !OPERATION_ID_PATTERN.test(dirent.name)) {
      continue;
    }
    const meta = await readTrashMeta(join(trashRoot, dirent.name));
    if (!meta) continue;
    const entry: TrashEntry = {
      operationId: dirent.name,
      originalRelativePath: meta.originalRelativePath,
      deletedAt: meta.deletedAt,
    };
    if (meta.stableNoteId) entry.stableNoteId = meta.stableNoteId;
    entries.push(entry);
  }
  entries.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  return entries;
}

/**
 * 从回收站恢复到原路径（§4.2）：
 * - 原父目录缺失时递归重建；
 * - 原路径已被占用时确定性改名恢复（"name (2).ext" 递增），返回实际路径；
 * - 恢复成功后删除 trash 条目目录。
 * @throws IpcFailure VAULT_TRASH_NOT_FOUND / VAULT_RESTORE_COLLISION / PATH_ESCAPE
 */
export async function restoreTrashEntry(input: {
  vaultRoot: string;
  operationId: string;
}): Promise<{ relativePath: string }> {
  const opDir = resolveTrashOpDir(input.vaultRoot, input.operationId);
  const meta = await readTrashMeta(opDir);
  if (!meta) {
    throw new IpcFailure(
      "VAULT_TRASH_NOT_FOUND",
      `回收站中找不到该条目：${input.operationId}`,
    );
  }

  // meta.json 是磁盘数据（可能被手工改动）：originalRelativePath 重新走
  // 静态校验 + 保留区判定，不信任删除时刻之外的任何写入。
  const original = meta.originalRelativePath;
  if (
    original.startsWith("/") ||
    original.startsWith("\\") ||
    /^[a-zA-Z]:[\\/]/.test(original) ||
    original.split("/").some((s) => s === "" || s === "." || s === "..")
  ) {
    throw new IpcFailure(
      "PATH_ESCAPE",
      `回收站条目的原始路径非法：${original}`,
    );
  }
  const assetsDirectory = await resolveAssetsDirectory(input.vaultRoot);
  assertNotReservedPath(original, assetsDirectory);

  const payloadDir = join(opDir, "payload");
  let payloadItems: string[];
  try {
    payloadItems = await readdir(payloadDir);
  } catch {
    throw new IpcFailure(
      "VAULT_TRASH_NOT_FOUND",
      `回收站条目内容缺失：${input.operationId}`,
    );
  }
  if (payloadItems.length !== 1) {
    throw new IpcFailure(
      "VAULT_TRASH_NOT_FOUND",
      `回收站条目内容缺失：${input.operationId}`,
    );
  }
  const payloadAbs = join(payloadDir, payloadItems[0]!);
  const payloadStats = await stat(payloadAbs);

  // 原父目录递归重建（§4.2）；重建后 realpath 复核仍在 Vault 根内。
  const rootReal = await realpath(input.vaultRoot);
  const segments = original.split("/");
  const parentSegments = segments.slice(0, -1);
  const parentAbs =
    parentSegments.length === 0 ? rootReal : join(rootReal, ...parentSegments);
  await mkdir(parentAbs, { recursive: true });
  const parentReal = await realpath(parentAbs);
  if (parentReal !== rootReal && !parentReal.startsWith(rootReal + sep)) {
    throw new IpcFailure(
      "PATH_ESCAPE",
      `恢复目标目录逃逸出 Vault 根：${original}`,
    );
  }

  // 确定性改名恢复：文件按最后一个点拆 stem/ext；目录无扩展名。
  const originalName = segments[segments.length - 1]!;
  let stem = originalName;
  let ext = "";
  if (!payloadStats.isDirectory()) {
    const dot = originalName.lastIndexOf(".");
    if (dot > 0) {
      stem = originalName.slice(0, dot);
      ext = originalName.slice(dot);
    }
  }
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const candidateName = nameForAttempt(stem, ext, attempt);
    const destAbs = join(parentReal, candidateName);
    if (await pathExists(destAbs)) continue;
    try {
      await fsRename(payloadAbs, destAbs);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EEXIST") continue;
      throw classifyFileOperationError(error);
    }
    await rm(opDir, { recursive: true, force: true }).catch(() => {});
    return { relativePath: toPosixRelative(rootReal, destAbs) };
  }
  throw new IpcFailure(
    "VAULT_RESTORE_COLLISION",
    "无法为恢复的条目分配不冲突的路径，请手动整理回收站。",
  );
}

/**
 * 永久删除（唯一物理删除入口）：指定 operationId 删单条；缺省清空整个
 * 回收站。返回物理删除的条目数。
 * @throws IpcFailure VAULT_TRASH_NOT_FOUND —— 指定条目不存在
 */
export async function purgeTrash(input: {
  vaultRoot: string;
  operationId?: string;
}): Promise<{ purged: number }> {
  const trashRoot = join(input.vaultRoot, TRASH_DIR);
  if (input.operationId !== undefined) {
    const opDir = resolveTrashOpDir(input.vaultRoot, input.operationId);
    try {
      await rm(opDir, { recursive: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        throw new IpcFailure(
          "VAULT_TRASH_NOT_FOUND",
          `回收站中找不到该条目：${input.operationId}`,
        );
      }
      throw classifyFileOperationError(error);
    }
    return { purged: 1 };
  }

  let names: string[];
  try {
    names = await readdir(trashRoot);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { purged: 0 };
    throw classifyFileOperationError(error);
  }
  for (const name of names) {
    await rm(join(trashRoot, name), { recursive: true, force: true });
  }
  return { purged: names.length };
}
