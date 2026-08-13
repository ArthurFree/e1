/**
 * R006 阶段 2：Vault 路径安全守卫（r006 §17）。
 *
 * 所有经 IPC 进入 Main 的相对路径一律不信任，统一经本模块解析：
 *   静态拒绝（空段 / "." / ".." / 绝对路径 / 盘符 / 反斜杠注入）
 *   → 拼接 → realpath（Vault 根与目标都解析真实路径）
 *   → 根内判定（前缀 + 路径分隔符边界，防 "vault-evil" 同前缀误判）
 * 符号链接逃逸由 realpath 天然暴露：目标经 symlink 指出 Vault 外时，
 * 真实路径不再以根为前缀，按 PATH_ESCAPE 拒绝。
 *
 * 本批实现「读取语义」与「将创建语义」：
 * - resolveWithinVault：目标必须存在（note.read / note.save）；
 * - resolveCreatablePathWithinVault：目标可不存在，校验父目录 realpath
 *   后拼接待创建文件名 + assertSafeFileName（note.create）。
 */
import { realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { IpcFailure } from "../../../shared/errors.js";

function pathEscape(message: string): never {
  throw new IpcFailure("PATH_ESCAPE", message);
}

/**
 * 把相对 Vault 根的路径解析为根内真实绝对路径。
 * @throws IpcFailure PATH_ESCAPE —— 静态形态非法或 realpath 后逃逸出 Vault 根
 * @throws IpcFailure NOTE_NOT_FOUND —— 目标不存在（读取语义）
 */
export async function resolveWithinVault(
  vaultRoot: string,
  relativePath: string,
): Promise<string> {
  // 静态拒绝（与 shared/ipc/schemas.assertRelativePath 同规则，Main 侧复查——
  // 不信任上游已校验；反斜杠一并按分隔符处理，防 Windows 形态绕过）。
  if (relativePath.trim() === "") {
    pathEscape("相对路径不能为空");
  }
  if (isAbsolute(relativePath) || /^[a-zA-Z]:[\\/]/.test(relativePath)) {
    pathEscape(`不允许绝对路径：${relativePath}`);
  }
  // 单字符切分（不带 +）：保留空段以便显式拒绝 "a//b.md" 这类形态。
  const segments = relativePath.split(/[\\/]/);
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    pathEscape(`相对路径含非法路径段：${relativePath}`);
  }

  // Vault 根必须真实存在；realpath 同时解析根自身的符号链接
  // （macOS /tmp → /private/tmp 之类），保证后续前缀比较两侧同为真实路径。
  const rootReal = await realpath(vaultRoot);
  const candidate = resolve(rootReal, ...segments);

  let targetReal: string;
  try {
    targetReal = await realpath(candidate);
  } catch {
    // 读取语义：目标必须存在；「将创建」语义（父目录 realpath 校验）见文件头。
    throw new IpcFailure("NOTE_NOT_FOUND", `目标路径不存在：${relativePath}`);
  }

  // 根内判定：等于根本身，或以「根 + 分隔符」为前缀（分隔符边界防止
  // 兄弟目录同前缀误判，如 /vault 与 /vault-evil）。
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) {
    pathEscape(`路径逃逸出 Vault 根：${relativePath}`);
  }
  return targetReal;
}

/**
 * 将创建语义：相对路径的目标文件可不存在；父目录必须存在且在 Vault 内。
 * 返回待创建文件的绝对路径（未经 realpath，因文件尚不存在）。
 * @throws IpcFailure PATH_ESCAPE / INVALID_INPUT / NOTE_NOT_FOUND（父目录缺失）
 */
export async function resolveCreatablePathWithinVault(
  vaultRoot: string,
  relativePath: string,
): Promise<string> {
  if (relativePath.trim() === "") {
    pathEscape("相对路径不能为空");
  }
  if (isAbsolute(relativePath) || /^[a-zA-Z]:[\\/]/.test(relativePath)) {
    pathEscape(`不允许绝对路径：${relativePath}`);
  }
  const segments = relativePath.split(/[\\/]/);
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    pathEscape(`相对路径含非法路径段：${relativePath}`);
  }
  const fileName = segments[segments.length - 1]!;
  assertSafeFileName(fileName);

  const rootReal = await realpath(vaultRoot);
  const parentRel = segments.slice(0, -1);
  const parentCandidate =
    parentRel.length === 0 ? rootReal : resolve(rootReal, ...parentRel);

  let parentReal: string;
  try {
    parentReal = await realpath(parentCandidate);
  } catch {
    throw new IpcFailure(
      "NOTE_NOT_FOUND",
      `目标目录不存在：${parentRel.join("/") || "."}`,
    );
  }
  if (parentReal !== rootReal && !parentReal.startsWith(rootReal + sep)) {
    pathEscape(`路径逃逸出 Vault 根：${relativePath}`);
  }
  return join(parentReal, fileName);
}

/** Windows 保留设备名（不区分大小写，含带扩展名形态如 "CON.txt"）。 */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** 文件系统非法字符（Windows 全集；POSIX 仅禁 "/" 与 NUL，取交集的超集）。 */
const ILLEGAL_CHARS = /[\\/:*?"<>|]/;

/** 控制字符检测（单独实现：ESLint no-control-regex 禁止正则内出现控制字符）。 */
function hasControlChar(name: string): boolean {
  for (const ch of name) {
    if (ch.charCodeAt(0) < 0x20) return true;
  }
  return false;
}

/** 文件名长度上限（字节）：主流文件系统（APFS/NTFS/ext4）均为 255。 */
const MAX_NAME_BYTES = 255;

/**
 * 文件/目录名合法性校验（供后续 note.create / asset.import 使用，本批先导出）。
 * 拒绝：空名、非法字符、控制字符、首尾空格或点（Windows 兼容）、
 * 保留设备名、超 255 字节。
 * @throws IpcFailure INVALID_INPUT
 */
export function assertSafeFileName(name: string): void {
  const invalid = (reason: string): never => {
    throw new IpcFailure("INVALID_INPUT", `非法文件名「${name}」：${reason}`);
  };
  if (name.trim() === "") invalid("不能为空");
  if (ILLEGAL_CHARS.test(name) || hasControlChar(name)) {
    invalid('含非法字符或控制字符（\\/:*?"<>|）');
  }
  if (name.startsWith(" ") || name.endsWith(" ") || name.endsWith(".")) {
    invalid("不允许首尾空格或结尾点");
  }
  if (RESERVED_NAME.test(name)) invalid("Windows 保留设备名");
  if (Buffer.byteLength(name, "utf8") > MAX_NAME_BYTES) {
    invalid("超过 255 字节");
  }
}
