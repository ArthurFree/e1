/**
 * R006-C5：Vault 受管资源文件系统。
 *
 * 新资源只写 `<vaultRoot>/<assetsDirectory>/`（assetsDirectory 来自
 * vault.json，禁止硬编码 "assets"）。目标必须在真实 assets root 内；
 * 同名冲突 exclusive create 递增；单文件 20 MiB 与 domain 同口径。
 */
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { IpcFailure } from "../../../shared/errors.js";
import { encodeDesktopAssetId } from "../../../shared/assets/desktopAssetId.js";
import {
  resolveCreatablePathWithinVault,
  resolveWithinVault,
} from "./PathGuard.js";
import { readVault } from "./VaultFileSystem.js";
import {
  assetFileNameForAttempt,
  inferMimeFromFileName,
  sanitizeAssetFileParts,
} from "./assetFileName.js";

/** 与 src/domain/attachments.MAX_ATTACHMENT_BYTES 同口径（Main 不得 import src）。 */
export const MAX_ASSET_FILE_BYTES = 20 * 1024 * 1024;

const MAX_CREATE_ATTEMPTS = 10_000;

export interface ImportAssetFileInput {
  vaultRoot: string;
  vaultId: string;
  fileName: string;
  mimeType: string;
  source:
    | { kind: "path"; absolutePath: string }
    | { kind: "bytes"; data: Uint8Array };
}

export interface ImportedAssetFile {
  assetId: string;
  relativePath: string;
  sizeBytes: number;
  mimeType: string;
}

export function classifyAssetWriteError(error: unknown): IpcFailure {
  if (error instanceof IpcFailure) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EACCES" || code === "EPERM") {
    return new IpcFailure(
      "ASSET_WRITE_PERMISSION_DENIED",
      "无法写入资源文件，当前系统用户没有该目录的写入权限。",
    );
  }
  return new IpcFailure(
    "ASSET_WRITE_IO_ERROR",
    "写入资源文件时发生系统错误，未留下半写入文件。",
  );
}

function assertSafeAssetsDirectory(assetsDirectory: string): string {
  const value = assetsDirectory.trim();
  if (!value) {
    throw new IpcFailure("INVALID_INPUT", "vault.json 缺少合法的 assetsDirectory");
  }
  if (value.includes("..") || value.startsWith("/") || /^[a-zA-Z]:/.test(value)) {
    throw new IpcFailure(
      "PATH_ESCAPE",
      `非法的 assetsDirectory：${assetsDirectory}`,
    );
  }
  const segments = value.split(/[\\/]/);
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new IpcFailure(
      "PATH_ESCAPE",
      `非法的 assetsDirectory：${assetsDirectory}`,
    );
  }
  return segments.join("/");
}

async function resolveAssetsRoot(
  vaultRoot: string,
): Promise<{ assetsDirectory: string; assetsRoot: string; vaultReal: string }> {
  const meta = await readVault(vaultRoot);
  if (meta.status !== "initialized") {
    throw new IpcFailure(
      "VAULT_NOT_FOUND",
      "当前文件夹尚未初始化为知识库，不能导入资源。",
    );
  }
  const assetsDirectory = assertSafeAssetsDirectory(meta.meta.assetsDirectory);
  const vaultReal = await realpath(vaultRoot);
  await mkdir(join(vaultReal, ...assetsDirectory.split("/")), { recursive: true });
  const assetsRoot = await realpath(join(vaultReal, ...assetsDirectory.split("/")));
  if (assetsRoot !== vaultReal && !assetsRoot.startsWith(vaultReal + sep)) {
    throw new IpcFailure("PATH_ESCAPE", "assetsDirectory 逃逸出 Vault 根");
  }
  return { assetsDirectory, assetsRoot, vaultReal };
}

function assertInsideAssetsRoot(absolutePath: string, assetsRoot: string): void {
  if (absolutePath !== assetsRoot && !absolutePath.startsWith(assetsRoot + sep)) {
    throw new IpcFailure("PATH_ESCAPE", "资源路径逃逸出受管资源目录");
  }
}

function assertSize(sizeBytes: number, name: string): void {
  if (sizeBytes > MAX_ASSET_FILE_BYTES) {
    throw new IpcFailure(
      "INVALID_INPUT",
      `附件「${name}」超过 ${Math.floor(MAX_ASSET_FILE_BYTES / 1024 / 1024)}MB 上限`,
      { sizeBytes, maxBytes: MAX_ASSET_FILE_BYTES },
    );
  }
}

/**
 * 把资源 exclusive create 进受管 assetsDirectory。
 * 调用方负责 Transient 拒写；本函数不感知 vaultId 通道。
 */
export async function importAssetFile(
  input: ImportAssetFileInput,
): Promise<ImportedAssetFile> {
  const { assetsDirectory, assetsRoot, vaultReal } = await resolveAssetsRoot(
    input.vaultRoot,
  );

  let sizeBytes: number;
  if (input.source.kind === "bytes") {
    sizeBytes = input.source.data.byteLength;
    assertSize(sizeBytes, input.fileName);
  } else {
    let st;
    try {
      st = await stat(input.source.absolutePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new IpcFailure(
          "ASSET_SOURCE_NOT_FOUND",
          "所选文件已经不存在，请重新选择。",
        );
      }
      throw classifyAssetWriteError(err);
    }
    if (!st.isFile()) {
      throw new IpcFailure("INVALID_INPUT", "只能导入普通文件。");
    }
    sizeBytes = st.size;
    assertSize(sizeBytes, input.fileName);
  }

  const mimeType =
    input.mimeType.trim() || inferMimeFromFileName(input.fileName);
  const { stem, ext } = sanitizeAssetFileParts(input.fileName);

  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
    const name = assetFileNameForAttempt(stem, ext, attempt);
    const relativePath = `${assetsDirectory}/${name}`;
    const absolutePath = await resolveCreatablePathWithinVault(
      input.vaultRoot,
      relativePath,
    );
    try {
      const parentReal = await realpath(dirname(absolutePath));
      assertInsideAssetsRoot(parentReal, assetsRoot);
    } catch (err) {
      throw classifyAssetWriteError(err);
    }

    try {
      if (input.source.kind === "bytes") {
        await writeFile(absolutePath, input.source.data, { flag: "wx" });
      } else {
        await copyFile(
          input.source.absolutePath,
          absolutePath,
          fsConstants.COPYFILE_EXCL,
        );
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") continue;
      throw classifyAssetWriteError(err);
    }

    let destReal: string;
    try {
      destReal = await realpath(absolutePath);
    } catch (err) {
      throw classifyAssetWriteError(err);
    }
    assertInsideAssetsRoot(destReal, assetsRoot);
    const posixRel = relative(vaultReal, destReal).split(sep).join("/");
    return {
      assetId: encodeDesktopAssetId(input.vaultId, posixRel),
      relativePath: posixRel,
      sizeBytes,
      mimeType,
    };
  }
  throw new IpcFailure("ASSET_WRITE_IO_ERROR", "无法为资源分配不冲突的文件名。");
}

export async function readAssetFile(input: {
  vaultRoot: string;
  relativePath: string;
}): Promise<{
  data: Uint8Array;
  mimeType: string;
  sizeBytes: number;
  name: string;
}> {
  const { assetsRoot } = await resolveAssetsRoot(input.vaultRoot);
  let absolutePath: string;
  try {
    absolutePath = await resolveWithinVault(input.vaultRoot, input.relativePath);
  } catch (err) {
    if (err instanceof IpcFailure && err.code === "NOTE_NOT_FOUND") {
      throw new IpcFailure("ASSET_NOT_FOUND", "资源文件不存在。");
    }
    throw err;
  }
  let destReal: string;
  try {
    destReal = await realpath(absolutePath);
  } catch {
    throw new IpcFailure("ASSET_NOT_FOUND", "资源文件不存在。");
  }
  assertInsideAssetsRoot(destReal, assetsRoot);
  try {
    const data = await readFile(destReal);
    return {
      data: new Uint8Array(data),
      mimeType: inferMimeFromFileName(input.relativePath),
      sizeBytes: data.byteLength,
      name: input.relativePath.split("/").pop() ?? input.relativePath,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new IpcFailure("ASSET_NOT_FOUND", "资源文件不存在。");
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new IpcFailure(
        "ASSET_WRITE_PERMISSION_DENIED",
        "无法读取资源文件，当前系统用户没有访问权限。",
      );
    }
    throw new IpcFailure("ASSET_WRITE_IO_ERROR", "读取资源文件时发生系统错误。");
  }
}
