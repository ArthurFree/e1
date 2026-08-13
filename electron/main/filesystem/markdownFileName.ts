/**
 * R006-C4-G（FR-49/50）：新建 Markdown 文件名清理与冲突递增。
 *
 * 标题 → 安全文件名（清理 \/:*?"<>|、控制字符、尾部空格/点、Windows 保留名）
 * → assertSafeFileName 复核 → exclusive create 冲突时确定性递增（2）（3）…
 */
import { assertSafeFileName } from "./PathGuard.js";

/** 文件系统非法字符（与 PathGuard 同集）。 */
const ILLEGAL_CHARS = /[\\/:*?"<>|]/g;

/** Windows 保留设备名（不区分大小写）。 */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** 控制字符剥离。 */
function stripControlChars(value: string): string {
  let out = "";
  for (const ch of value) {
    if (ch.charCodeAt(0) >= 0x20) out += ch;
  }
  return out;
}

/**
 * 标题 → 不含扩展名的安全 stem（空标题 →「无标题」）。
 * 例：`React / Fiber` → `React - Fiber`；`CON` → `CON_`。
 */
export function sanitizeMarkdownStem(title: string): string {
  let stem = stripControlChars(title).replace(ILLEGAL_CHARS, "-");
  stem = stem.replace(/\s+/g, " ").trim();
  // 去掉尾部点与空格（Windows 兼容）；反复直到稳定。
  while (stem.endsWith(".") || stem.endsWith(" ")) {
    stem = stem.replace(/[.\s]+$/, "");
  }
  if (stem === "") stem = "无标题";
  if (RESERVED_NAME.test(stem)) stem = `${stem}_`;
  // 超长时截断到 200 字节（留出「 (nnn).md」余量）。
  while (Buffer.byteLength(stem, "utf8") > 200) {
    stem = stem.slice(0, -1);
  }
  while (stem.endsWith(".") || stem.endsWith(" ")) {
    stem = stem.replace(/[.\s]+$/, "");
  }
  if (stem === "") stem = "无标题";
  return stem;
}

/**
 * 冲突序号对应的文件名：0 → `React.md`；1 → `React (2).md`；2 → `React (3).md`。
 */
export function markdownFileNameForAttempt(stem: string, attempt: number): string {
  const name =
    attempt === 0 ? `${stem}.md` : `${stem} (${attempt + 1}).md`;
  assertSafeFileName(name);
  return name;
}

/** 标题直接到首个候选文件名（未递增）。 */
export function sanitizeMarkdownFileName(title: string): string {
  return markdownFileNameForAttempt(sanitizeMarkdownStem(title), 0);
}
