/**
 * R014：目录树指纹与拷贝校验（Main only）。
 * Source 在 Destination 完整验证之前永不删除。
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export interface HashedFile {
  relativePath: string;
  size: number;
  sha256: string;
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

export async function walkHashedFiles(
  root: string,
): Promise<HashedFile[]> {
  const files: HashedFile[] = [];
  await walk(root, root, files);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return files;
}

async function walk(
  root: string,
  dir: string,
  files: HashedFile[],
): Promise<void> {
  const dirents = await readdir(dir, { withFileTypes: true });
  for (const dirent of dirents) {
    const abs = join(dir, dirent.name);
    if (dirent.isSymbolicLink()) continue;
    if (dirent.isDirectory()) {
      await walk(root, abs, files);
    } else if (dirent.isFile()) {
      const bytes = await readFile(abs);
      files.push({
        relativePath: toPosix(relative(root, abs)),
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
}

export function fingerprintFiles(files: HashedFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file.relativePath}:${file.size}:${file.sha256}\n`);
  }
  return hash.digest("hex");
}

export async function copyDirectoryContents(
  sourceRoot: string,
  destRoot: string,
): Promise<void> {
  await mkdir(destRoot, { recursive: true });
  const dirents = await readdir(sourceRoot, { withFileTypes: true });
  for (const dirent of dirents) {
    const from = join(sourceRoot, dirent.name);
    const to = join(destRoot, dirent.name);
    if (dirent.isSymbolicLink()) continue;
    if (dirent.isDirectory()) {
      await copyDirectoryContents(from, to);
    } else if (dirent.isFile()) {
      await copyFile(from, to);
    }
  }
}

export function verifyCopiedTrees(
  source: HashedFile[],
  dest: HashedFile[],
): string[] {
  const errors: string[] = [];
  if (source.length !== dest.length) {
    errors.push(
      `文件数量不一致：源 ${source.length}，目标 ${dest.length}`,
    );
  }
  const destByPath = new Map(dest.map((f) => [f.relativePath, f]));
  for (const file of source) {
    const other = destByPath.get(file.relativePath);
    if (!other) {
      errors.push(`目标缺失：${file.relativePath}`);
      continue;
    }
    if (other.size !== file.size || other.sha256 !== file.sha256) {
      errors.push(`内容不一致：${file.relativePath}`);
    }
  }
  return errors;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function isEmptyDirectory(path: string): Promise<boolean> {
  try {
    const dirents = await readdir(path);
    return dirents.length === 0;
  } catch {
    return false;
  }
}

export async function removePath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
