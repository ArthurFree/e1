/**
 * R006-C4-B（FR-05~FR-11）：原子 Markdown 写入。
 *
 * 流程（SEC-05~09）：
 *   读目标当前 bytes → SHA256 vs expectedVersionToken
 *     不一致 → DOCUMENT_CONFLICT（不写）
 *   同目录临时文件 .<basename>.e1-tmp-<random>
 *   写入完整新内容 → FileHandle.sync() → close
 *   再次读取目标 SHA（第二次校验）→ 冲突则删 temp
 *   rename 原子替换 → stat + 最终 SHA256
 *
 * BOM 跟随：若当前磁盘文件以 UTF-8 BOM 开头，新内容同样加 BOM；
 * 原文件无 BOM 则不加。失败路径绝不 truncate 原文件，并清理 temp。
 */
import { createHash, randomBytes } from "node:crypto";
import { open, readFile, rename as fsRename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { IpcFailure } from "../../../shared/errors.js";
import { MAX_MARKDOWN_FILE_SIZE } from "./NoteFileSystem.js";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export interface AtomicWriteInput {
  /** 目标文件绝对路径（已由调用方经 PathGuard 解析）。 */
  targetPath: string;
  /** 新文件正文字节（UTF-8，不含 BOM；本模块按磁盘现状决定是否加 BOM）。 */
  bytes: Uint8Array;
  /** 期望的磁盘版本令牌（sha256:<64 hex>）。 */
  expectedVersionToken: string;
}

export interface AtomicWriteResult {
  versionToken: string;
  modifiedAt: number;
  sizeBytes: number;
}

/**
 * 仅供单元测试注入的竞态挂钩（R006-C4.1 FR-25）。
 * 不进入 IPC、不暴露给 Renderer；生产调用不传。
 */
export interface AtomicWriteHooks {
  /** temp 写完并 sync 之后、第二次 SHA 之前。 */
  afterTempSynced?(): Promise<void>;
  /** 可注入 rename spy（断言冲突路径未替换目标）。 */
  rename?(from: string, to: string): Promise<void>;
}

/** 对任意字节计算 sha256:<hex> 版本令牌。 */
export function sha256Token(bytes: Uint8Array | Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** 写入失败分类（FR-10）：EACCES/EPERM → 写权限；其余 I/O → 写 I/O。 */
export function classifyNoteWriteError(error: unknown): IpcFailure {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EACCES" || code === "EPERM") {
    return new IpcFailure(
      "NOTE_WRITE_PERMISSION_DENIED",
      "无法保存 Markdown，当前系统用户没有该文件的写入权限。你的编辑内容仍保留在当前应用中。",
    );
  }
  return new IpcFailure(
    "NOTE_WRITE_IO_ERROR",
    "保存 Markdown 时发生系统错误，原文件没有被主动清空。",
  );
}

/**
 * 原子写入目标 Markdown。
 * @throws IpcFailure DOCUMENT_CONFLICT / NOTE_WRITE_* / DOCUMENT_TOO_LARGE / NOTE_NOT_FOUND
 */
export async function atomicWriteFile(
  input: AtomicWriteInput,
  hooks: AtomicWriteHooks = {},
): Promise<AtomicWriteResult> {
  const { targetPath, expectedVersionToken } = input;
  if (input.bytes.byteLength > MAX_MARKDOWN_FILE_SIZE) {
    throw new IpcFailure(
      "DOCUMENT_TOO_LARGE",
      "这篇 Markdown 序列化结果过大，当前版本暂不支持保存（上限 10 MB）。",
      {
        sizeBytes: input.bytes.byteLength,
        maxBytes: MAX_MARKDOWN_FILE_SIZE,
      },
    );
  }

  // 第一次校验：读当前磁盘字节并比对 expectedVersionToken。
  let currentRaw: Buffer;
  try {
    currentRaw = await readFile(targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new IpcFailure("NOTE_NOT_FOUND", `目标路径不存在：${targetPath}`);
    }
    throw classifyNoteWriteError(error);
  }
  const currentToken = sha256Token(currentRaw);
  if (currentToken !== expectedVersionToken) {
    throw new IpcFailure(
      "DOCUMENT_CONFLICT",
      "这篇笔记已在 E1 之外发生修改，为了避免覆盖外部修改，自动保存已暂停。",
      { expectedVersionToken, currentVersionToken: currentToken },
    );
  }

  // BOM 跟随：原文件有 BOM → 新内容同样加；无则不加。
  const hadBom =
    currentRaw.length >= 3 &&
    currentRaw[0] === 0xef &&
    currentRaw[1] === 0xbb &&
    currentRaw[2] === 0xbf;
  const body = Buffer.from(input.bytes);
  const writeBytes = hadBom ? Buffer.concat([UTF8_BOM, body]) : body;

  // 同目录临时文件（SEC-06）：不可预测、带 E1 前缀。
  const dir = dirname(targetPath);
  const base = basename(targetPath);
  const tempPath = join(
    dir,
    `.${base}.e1-tmp-${randomBytes(8).toString("hex")}`,
  );

  try {
    // 写完整新内容到 temp，再 sync（FR-06）。
    const handle = await open(tempPath, "w");
    try {
      await handle.writeFile(writeBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (hooks.afterTempSynced) {
      await hooks.afterTempSynced();
    }

    // 第二次校验：rename 前再读目标 SHA（SEC-09）。
    let recheckRaw: Buffer;
    try {
      recheckRaw = await readFile(targetPath);
    } catch (error) {
      await safeUnlink(tempPath);
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new IpcFailure("NOTE_NOT_FOUND", `目标路径不存在：${targetPath}`);
      }
      throw classifyNoteWriteError(error);
    }
    const recheckToken = sha256Token(recheckRaw);
    if (recheckToken !== expectedVersionToken) {
      await safeUnlink(tempPath);
      throw new IpcFailure(
        "DOCUMENT_CONFLICT",
        "这篇笔记已在 E1 之外发生修改，为了避免覆盖外部修改，自动保存已暂停。",
        { expectedVersionToken, currentVersionToken: recheckToken },
      );
    }

    try {
      await (hooks.rename ?? fsRename)(tempPath, targetPath);
    } catch (error) {
      await safeUnlink(tempPath);
      throw classifyNoteWriteError(error);
    }
  } catch (error) {
    // 上层已清理 temp 的冲突/权限路径直接再抛；未预料的失败再尝试清理。
    if (!(error instanceof IpcFailure)) {
      await safeUnlink(tempPath);
      throw classifyNoteWriteError(error);
    }
    throw error;
  }

  const stats = await stat(targetPath);
  const finalRaw = await readFile(targetPath);
  return {
    versionToken: sha256Token(finalRaw),
    modifiedAt: Math.round(stats.mtimeMs),
    sizeBytes: stats.size,
  };
}

/** 失败路径清理 temp；清理自身失败静默（不影响主错误）。 */
async function safeUnlink(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    // ignore
  }
}
