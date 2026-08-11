/**
 * R006-C3-A（FR-06~FR-11，r006-c3 §14–§19）：Markdown 笔记文件系统层。
 *
 * 职责（且仅这些，FR-06）：定位 Markdown → 读取 → 大小检查 → 编码检查 →
 * Hash。不做任何 Markdown AST 解析（PR-05：Main 不理解编辑器模型；
 * Frontmatter id 提取在 IPC 层经 shared/markdown/frontmatter 纯字符串完成）。
 *
 * 安全口径（SEC-02/03/06/07）：
 * - 相对路径一律经 PathGuard.resolveWithinVault 复核（静态拒绝 .. / . / 空段
 *   / 绝对路径 / 盘符 / 反斜杠注入，realpath 后 symlink 指出 Vault 根即
 *   PATH_ESCAPE）；扩展名在「入参相对路径」与「realpath 后的真实路径」两侧
 *   都必须是 .md（大小写不敏感）——后者防止 vault 内 symlink 把 .md 名义
 *   映射到非 Markdown 目标；
 * - 单文件上限 10 MiB（FR-09），超限抛 DOCUMENT_TOO_LARGE（details 携带
 *   { sizeBytes, maxBytes } 供 UI 展示）；
 * - 只支持 UTF-8 / UTF-8 BOM（FR-10）：BOM 剥离后 fatal 解码，失败抛
 *   UNSUPPORTED_ENCODING——不猜测 GBK 等、不转码；
 * - 本模块只有读取，任何失败都不修改文件（SEC-07）。
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { IpcFailure } from "../../../shared/errors.js";
import { resolveWithinVault } from "./PathGuard.js";

/** FR-09：单文件大小上限 10 MiB。 */
export const MAX_MARKDOWN_FILE_SIZE = 10 * 1024 * 1024;

export interface ReadNoteFileInput {
  vaultRoot: string;
  relativePath: string;
}

export interface ReadNoteFileResult {
  /** Markdown 原文（UTF-8 解码、已剥离 BOM；含 Frontmatter，未做任何归一）。 */
  markdown: string;
  /**
   * 版本令牌："sha256:<64 lowercase hex>"。
   * 字节口径（在此锁定）：对**磁盘原始字节**计算——含 BOM、含原始换行，
   * 与「文件是否被外部修改」的直觉一致，也直接可作 C4 乐观锁的
   * expectedVersionToken 比较基准。
   */
  versionToken: string;
  /** 文件最后修改时间（ms 整数，取自 stat.mtimeMs 四舍五入）。 */
  modifiedAt: number;
  sizeBytes: number;
}

/** 扩展名必须为 .md（大小写不敏感，FR-08）。 */
const MARKDOWN_EXTENSION = /\.md$/i;

/**
 * R006-C3（FR-23/24/25）：读取失败的错误分类（与 VaultFileSystem 的
 * classifyVaultReadError 同模式，语义换成笔记侧三码）。
 * 导出为纯函数便于测试（EACCES/EPERM/EIO 难以用真实文件系统稳定模拟）。
 * ENOENT/ENOTDIR → null（由调用方按 NOTE_NOT_FOUND 处理）。
 */
export function classifyNoteReadError(error: unknown): IpcFailure | null {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return null;
  if (code === "EACCES" || code === "EPERM") {
    return new IpcFailure(
      "NOTE_PERMISSION_DENIED",
      "无法读取该 Markdown，请检查当前系统用户是否具有该文件的读取权限。",
    );
  }
  return new IpcFailure(
    "NOTE_IO_ERROR",
    "读取 Markdown 时发生系统错误，文件本身没有被修改。",
  );
}

/** 读取并校验一个 Markdown 文件，返回原文 + SHA256 版本令牌 + 来源信息。 */
export async function readNoteFile(
  input: ReadNoteFileInput,
): Promise<ReadNoteFileResult> {
  const { vaultRoot, relativePath } = input;

  // FR-08：扩展名静态预检（纯字符串，先拒绝明显非 Markdown 入参；
  // 真实路径侧复查在 resolveWithinVault 之后，防 symlink 名义欺骗）。
  if (!MARKDOWN_EXTENSION.test(relativePath)) {
    throw new IpcFailure(
      "INVALID_INPUT",
      `只支持读取 Markdown（.md）文件：${relativePath}`,
    );
  }

  // PathGuard 复核（SEC-02）：静态形态 + realpath + 根内判定；
  // 目标不存在（读取语义）抛 NOTE_NOT_FOUND，逃逸抛 PATH_ESCAPE。
  const target = await resolveWithinVault(vaultRoot, relativePath);
  if (!MARKDOWN_EXTENSION.test(target)) {
    throw new IpcFailure(
      "INVALID_INPUT",
      "符号链接目标不是 Markdown（.md）文件，已拒绝读取。",
    );
  }

  let stats;
  try {
    stats = await stat(target);
  } catch (error) {
    // realpath 与 stat 之间的竞态/权限变化按读取语义分类。
    const classified = classifyNoteReadError(error);
    if (!classified) {
      throw new IpcFailure("NOTE_NOT_FOUND", `目标路径不存在：${relativePath}`);
    }
    throw classified;
  }
  // FR-08：目标是目录（即使目录名以 .md 结尾）一律拒绝。
  if (!stats.isFile()) {
    throw new IpcFailure(
      "INVALID_INPUT",
      `目标是目录而非 Markdown 文件：${relativePath}`,
    );
  }

  // FR-09：大小上限——stat 预检 + 读取后实测复查（防 stat 与 read 之间
  // 文件被外部追加增大）。
  assertSizeWithinLimit(stats.size);

  let raw: Buffer;
  try {
    raw = await readFile(target);
  } catch (error) {
    const classified = classifyNoteReadError(error);
    if (!classified) {
      throw new IpcFailure("NOTE_NOT_FOUND", `目标路径不存在：${relativePath}`);
    }
    throw classified;
  }
  assertSizeWithinLimit(raw.length);

  // FR-11：对磁盘原始字节（含 BOM、原始换行）计算 SHA-256。
  const versionToken = `sha256:${createHash("sha256").update(raw).digest("hex")}`;

  // FR-10：UTF-8 BOM（EF BB BF）剥离；fatal 解码，不猜测其他编码。
  const body =
    raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
      ? raw.subarray(3)
      : raw;
  let markdown: string;
  try {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new IpcFailure(
      "UNSUPPORTED_ENCODING",
      "当前文件可能不是 UTF-8 编码，E1 暂时无法安全打开该 Markdown（文件保持原样，未做任何修改）。",
    );
  }

  return {
    markdown,
    versionToken,
    modifiedAt: Math.round(stats.mtimeMs),
    sizeBytes: stats.size,
  };
}

/** 大小超限统一抛 DOCUMENT_TOO_LARGE，details 携带实测值与上限（FR-09）。 */
function assertSizeWithinLimit(sizeBytes: number): void {
  if (sizeBytes > MAX_MARKDOWN_FILE_SIZE) {
    throw new IpcFailure(
      "DOCUMENT_TOO_LARGE",
      "这篇 Markdown 文件过大，当前版本暂不支持直接打开（上限 10 MB）。",
      { sizeBytes, maxBytes: MAX_MARKDOWN_FILE_SIZE },
    );
  }
}
