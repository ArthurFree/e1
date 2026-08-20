/**
 * R007 阶段 4（§4.1/§4.3/§4.4）：Vault 内文件操作——新建分组目录、
 * 移动文档（document → directory）、物理文件名重命名。
 *
 * 共同约束：
 * - 全部经 PathGuard 解析（realpath 根内判定，symlink 逃逸天然拒绝）；
 * - 保留区（首段 .e1 / 受管 assetsDirectory，大小写不敏感）拒绝读写
 *   （VAULT_RESERVED_PATH）——.e1 含 vault.json 与 trash，assets 为受管
 *   附件存储，均不得作为分组/文档目标；
 * - 新建目录同名确定性递增（"name (2)"，与 note.create 同口径）；
 *   move / renameFile 冲突报错（VAULT_PATH_COLLISION，§4.3「检测
 *   collision」——不自动改名，由 UI 决定后续交互）；
 * - 移动/重命名为纯 rename：Frontmatter 逐字节不动，stable note id 不变
 *   （验收：stable note id 不变）。
 */
import {
  lstat,
  mkdir,
  realpath,
  rename as fsRename,
  stat,
} from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { IpcFailure } from "../../../shared/errors.js";
import { assertSafeFileName, resolveWithinVault } from "./PathGuard.js";
import { readVault } from "./VaultFileSystem.js";

/** 冲突递增上限（与 note.create / asset.import 同口径，防异常死循环）。 */
const MAX_ATTEMPTS = 10_000;

/** 扩展名必须为 .md（大小写不敏感）。 */
const MARKDOWN_EXTENSION = /\.md$/i;

/** 受管资源目录名（vault.json；未初始化目录无受管约定，回退默认 "assets"）。 */
export async function resolveAssetsDirectory(
  vaultRoot: string,
): Promise<string> {
  const meta = await readVault(vaultRoot);
  return meta.status === "initialized" ? meta.meta.assetsDirectory : "assets";
}

/** 保留区判定：POSIX 相对路径首段为 .e1 或受管 assetsDirectory（大小写不敏感）。 */
export function isReservedPath(
  relativePath: string,
  assetsDirectory: string,
): boolean {
  const first = relativePath.split("/")[0]!.toLowerCase();
  return first === ".e1" || first === assetsDirectory.toLowerCase();
}

/** @throws IpcFailure VAULT_RESERVED_PATH —— 路径触及 .e1 / 受管资源目录。 */
export function assertNotReservedPath(
  relativePath: string,
  assetsDirectory: string,
): void {
  if (isReservedPath(relativePath, assetsDirectory)) {
    throw new IpcFailure(
      "VAULT_RESERVED_PATH",
      `该路径位于受管保留区（.e1 或附件目录），不能执行此操作：${relativePath}`,
    );
  }
}

/** 文件操作写失败分类：EACCES/EPERM → 写权限；其余 I/O → 写 I/O。 */
export function classifyFileOperationError(error: unknown): IpcFailure {
  if (error instanceof IpcFailure) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EACCES" || code === "EPERM") {
    return new IpcFailure(
      "NOTE_WRITE_PERMISSION_DENIED",
      "无法完成文件操作，当前系统用户没有该文件或目录的写入权限。",
    );
  }
  return new IpcFailure(
    "NOTE_WRITE_IO_ERROR",
    "执行文件操作时发生系统错误，请重新尝试。",
  );
}

/** 绝对路径相对根 → POSIX 风格相对路径（跨平台统一 "/" 分隔）。 */
export function toPosixRelative(
  rootReal: string,
  absolutePath: string,
): string {
  return relative(rootReal, absolutePath).split(sep).join("/");
}

/** 存在性检测（lstat：悬空符号链接也视为存在，避免 rename 静默覆盖）。 */
export async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await lstat(absolutePath);
    return true;
  } catch {
    return false;
  }
}

/** 确定性递增候选名：0 → "name(.ext)"；1 → "name (2)(.ext)"（与 markdownFileName 同形态）。 */
export function nameForAttempt(
  stem: string,
  ext: string,
  attempt: number,
): string {
  return attempt === 0 ? `${stem}${ext}` : `${stem} (${attempt + 1})${ext}`;
}

/**
 * 解析目标目录（"" = Vault 根）为根内真实绝对路径 + POSIX 相对路径。
 * @throws IpcFailure VAULT_RESERVED_PATH / NOTE_NOT_FOUND / INVALID_INPUT（非目录）
 */
async function resolveTargetDirectory(
  vaultRoot: string,
  directory: string,
  assetsDirectory: string,
): Promise<{ rootReal: string; dirAbs: string; dirRelPosix: string }> {
  const rootReal = await realpath(vaultRoot);
  if (directory === "") {
    return { rootReal, dirAbs: rootReal, dirRelPosix: "" };
  }
  assertNotReservedPath(directory, assetsDirectory);
  const dirAbs = await resolveWithinVault(vaultRoot, directory);
  const stats = await stat(dirAbs);
  if (!stats.isDirectory()) {
    throw new IpcFailure("INVALID_INPUT", `目标路径不是目录：${directory}`);
  }
  return { rootReal, dirAbs, dirRelPosix: toPosixRelative(rootReal, dirAbs) };
}

/**
 * R007 阶段 4（§4.1）：新建分组目录。同名冲突确定性递增（"name (2)"）；
 * 根级保留名（.e1 / assetsDirectory，大小写不敏感）拒绝；点开头名称拒绝
 * （扫描器跳过点开头段，建了也不可见）。
 */
export async function createVaultDirectory(input: {
  vaultRoot: string;
  /** 父目录相对路径；空串为 Vault 根。 */
  parentRelativePath: string;
  /** 新目录名（单段）。 */
  name: string;
}): Promise<{ relativePath: string }> {
  const assetsDirectory = await resolveAssetsDirectory(input.vaultRoot);
  assertSafeFileName(input.name);
  if (input.name.startsWith(".")) {
    // .e1 属保留区口径；其余点开头名建了也不会出现在页面树，一并拒绝。
    const code =
      input.name.toLowerCase() === ".e1"
        ? "VAULT_RESERVED_PATH"
        : "INVALID_INPUT";
    throw new IpcFailure(
      code,
      `非法目录名「${input.name}」：不允许以点开头（隐藏目录不会出现在页面树）。`,
    );
  }
  const { dirAbs: parentAbs, dirRelPosix: parentRel } =
    await resolveTargetDirectory(
      input.vaultRoot,
      input.parentRelativePath,
      assetsDirectory,
    );
  if (parentRel === "" && isReservedPath(input.name, assetsDirectory)) {
    throw new IpcFailure(
      "VAULT_RESERVED_PATH",
      `「${input.name}」是知识库保留目录名，不能用做分组名。`,
    );
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const dirName = nameForAttempt(input.name, "", attempt);
    assertSafeFileName(dirName);
    try {
      // 父目录已解析存在，无需 recursive（也避免意外创建中间层）。
      await mkdir(join(parentAbs, dirName));
      return {
        relativePath: parentRel === "" ? dirName : `${parentRel}/${dirName}`,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EEXIST") {
        lastError = error;
        continue;
      }
      throw classifyFileOperationError(error);
    }
  }
  throw classifyFileOperationError(
    lastError ?? new Error("create directory attempts exhausted"),
  );
}

/**
 * R007 阶段 4（§4.3）：移动文档到目标目录（document → directory）。
 * 纯 rename：Frontmatter 与 stable note id 不变。冲突报错
 * （VAULT_PATH_COLLISION），不自动改名；源已在目标目录时为 no-op。
 */
export async function moveNoteFile(input: {
  vaultRoot: string;
  relativePath: string;
  /** 目标目录相对路径；空串为 Vault 根。 */
  targetDirectory: string;
}): Promise<{ relativePath: string }> {
  const assetsDirectory = await resolveAssetsDirectory(input.vaultRoot);
  assertNotReservedPath(input.relativePath, assetsDirectory);
  const sourceAbs = await resolveWithinVault(
    input.vaultRoot,
    input.relativePath,
  );
  const sourceStats = await stat(sourceAbs);
  if (!sourceStats.isFile() || !MARKDOWN_EXTENSION.test(basename(sourceAbs))) {
    throw new IpcFailure(
      "INVALID_INPUT",
      `note.move 只支持移动 Markdown（.md）文档：${input.relativePath}`,
    );
  }

  const { rootReal, dirAbs: targetDirAbs } = await resolveTargetDirectory(
    input.vaultRoot,
    input.targetDirectory,
    assetsDirectory,
  );
  const destAbs = join(targetDirAbs, basename(sourceAbs));
  if (destAbs === sourceAbs) {
    // 源已在目标目录：no-op，直接返回现状路径。
    return { relativePath: toPosixRelative(rootReal, sourceAbs) };
  }
  if (await pathExists(destAbs)) {
    throw new IpcFailure(
      "VAULT_PATH_COLLISION",
      `目标目录已存在同名文件：${toPosixRelative(rootReal, destAbs)}`,
    );
  }
  try {
    await fsRename(sourceAbs, destAbs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EEXIST") {
      throw new IpcFailure(
        "VAULT_PATH_COLLISION",
        `目标目录已存在同名文件：${toPosixRelative(rootReal, destAbs)}`,
      );
    }
    throw classifyFileOperationError(error);
  }
  return { relativePath: toPosixRelative(rootReal, destAbs) };
}

/**
 * R007 阶段 4（§4.4「重命名文件」）：物理文件名 rename（目录不变、
 * 必须 .md 结尾）。与 Title rename（note.patchMetadata）相互独立；
 * 冲突报错（VAULT_PATH_COLLISION）；新旧同名时 no-op。
 */
export async function renameNoteFile(input: {
  vaultRoot: string;
  relativePath: string;
  /** 新文件名（单段，必须 .md 结尾）。 */
  newName: string;
}): Promise<{ relativePath: string }> {
  const assetsDirectory = await resolveAssetsDirectory(input.vaultRoot);
  assertNotReservedPath(input.relativePath, assetsDirectory);
  if (!MARKDOWN_EXTENSION.test(input.newName)) {
    throw new IpcFailure(
      "INVALID_INPUT",
      `新文件名必须以 .md 结尾：${input.newName}`,
    );
  }
  assertSafeFileName(input.newName);
  const sourceAbs = await resolveWithinVault(
    input.vaultRoot,
    input.relativePath,
  );
  const sourceStats = await stat(sourceAbs);
  if (!sourceStats.isFile() || !MARKDOWN_EXTENSION.test(basename(sourceAbs))) {
    throw new IpcFailure(
      "INVALID_INPUT",
      `note.renameFile 只支持重命名 Markdown（.md）文件：${input.relativePath}`,
    );
  }

  const rootReal = await realpath(input.vaultRoot);
  const destAbs = join(dirname(sourceAbs), input.newName);
  if (destAbs === sourceAbs) {
    return { relativePath: toPosixRelative(rootReal, sourceAbs) };
  }
  if (await pathExists(destAbs)) {
    throw new IpcFailure(
      "VAULT_PATH_COLLISION",
      `同目录已存在同名文件：${input.newName}`,
    );
  }
  try {
    await fsRename(sourceAbs, destAbs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EEXIST") {
      throw new IpcFailure(
        "VAULT_PATH_COLLISION",
        `同目录已存在同名文件：${input.newName}`,
      );
    }
    throw classifyFileOperationError(error);
  }
  return { relativePath: toPosixRelative(rootReal, destAbs) };
}
