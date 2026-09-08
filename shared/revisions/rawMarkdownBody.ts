/**
 * R012 Stage 0：raw Markdown body 工具（REV-02：Desktop 版本历史的权威快照
 * 是 raw Markdown body，不是 Tiptap JSON / textSnapshot）。
 *
 * 职责边界：
 * - 只做纯字符串处理——拆 body、探测行尾 / BOM、生成轻量文本摘要；
 * - **不做** SHA-256（需要 node:crypto，由 Main 侧复用
 *   electron/main/filesystem/AtomicFileWriter.ts 的 sha256Token 计算）；
 * - **不做** 行尾归一化：body 按原始字节内容切出，LF/CRLF/BOM 原样保留
 *   （source-preserving，与 R011.1 R11C-06 同一口径）。
 *
 * body 边界判定复用 shared/markdown/frontmatter 的
 * frontmatterBodyStartOffset（BOM/CRLF 感知，与 splitFrontmatter 同规则），
 * 保证「快照的 body」与「解析器眼中的正文」永远是同一段文本。
 */

import { frontmatterBodyStartOffset } from "../markdown/frontmatter.js";

/** 行尾风格：快照 manifest 的 lineEnding 字段取值。 */
export type MarkdownLineEnding = "lf" | "crlf";

/** splitRawMarkdownBody 的结果：body 原文 + 结构探测信息。 */
export interface RawMarkdownBody {
  /**
   * 剥离 Frontmatter 后的正文原文（含原始行尾，不做归一化）；
   * 无 Frontmatter 时为整个输入；Frontmatter 后无正文时为空串。
   */
  body: string;
  /** 输入是否含 Frontmatter 块（BOM + `---` 也算有）。 */
  hasFrontmatter: boolean;
  /** 输入是否以 UTF-8 BOM（U+FEFF）开头。 */
  hasBom: boolean;
  /** 按全文第一个换行符探测的行尾风格；无换行时视为 "lf"。 */
  lineEnding: MarkdownLineEnding;
}

/**
 * 从整篇 Markdown 原文切出 raw body。
 * 输入可以带 BOM、CRLF；返回的 body 是原串的子串（slice），
 * 逐字节等于原文件中的正文区域，可直接落盘为快照 body.md。
 */
export function splitRawMarkdownBody(markdown: string): RawMarkdownBody {
  const offset = frontmatterBodyStartOffset(markdown);
  return {
    body: markdown.slice(offset),
    hasFrontmatter: offset > 0,
    hasBom: markdown.charCodeAt(0) === 0xfeff,
    lineEnding: detectLineEnding(markdown),
  };
}

/**
 * 探测行尾风格：看全文第一个 `\n`，其前一字符是 `\r` 则为 CRLF。
 * 无换行（空串 / 单行）时回退 "lf"。混合行尾以第一个换行为准
 * （探测只用于 manifest 记录，不触发任何归一化）。
 */
export function detectLineEnding(text: string): MarkdownLineEnding {
  const newline = text.indexOf("\n");
  if (newline > 0 && text.charCodeAt(newline - 1) === 0x0d) return "crlf";
  return "lf";
}

/**
 * 快照 textPreview 的最大字符数（Desktop manifest 与 Web/内存
 * RevisionSummary.textPreview 共用同一截断口径）。
 */
export const REVISION_TEXT_PREVIEW_MAX_CHARS = 200;

/** fenced code 围栏行（``` 或 ~~~ 开头）。 */
const FENCE_LINE = /^\s*(`{3,}|~{3,})/;
/** 表格分隔行（`| --- | --- |` 及其变体）。 */
const TABLE_SEPARATOR = /^\|?[\s:|-]+\|[\s:|-]*$/;

/**
 * 去掉一行的块级 Markdown 标记（标题 #、引用 >、列表/任务列表记号），
 * 返回纯文本内容；整行无文本（如分隔线 `---`、表格分隔行）返回空串。
 */
function stripBlockMarkers(line: string): string {
  let text = line.trim();
  if (text === "") return "";
  if (/^#{1,6}\s/.test(text)) text = text.replace(/^#{1,6}\s+/, "");
  text = text.replace(/^(?:>\s?)+/, "");
  text = text.replace(/^[-*+]\s+/, "");
  text = text.replace(/^\d{1,9}[.)]\s+/, "");
  text = text.replace(/^\[[ xX]\]\s+/, "");
  if (text === "" || /^[-*_]{3,}$/.test(text)) return "";
  if (TABLE_SEPARATOR.test(text)) return "";
  // 表格行：竖线改为空格（`单元 | 单元` → `单元 单元`）。
  if (text.includes("|")) text = text.replace(/\|/g, " ");
  return text.trim();
}

/** 去掉一行的行内 Markdown 标记（强调/删除线/行内代码/链接/图片）。 */
function stripInlineMarkers(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // 图片 → alt 文本
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // 链接 → 链接文字
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\*)/g, "$1$2")
    .replace(/(^|[^\w_])_([^_\n]+)_(?!_)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .trim();
}

/**
 * 从 raw body 提取轻量文本摘要（快照 manifest / RevisionSummary 的
 * textPreview）：逐行剥离块级与行内 Markdown 标记，fenced code 内容按
 * 原文计入（与 textSnapshot 含代码文本的常识一致），折叠空白后按
 * maxChars 截断。不做重量级 Markdown 解析——这是列表展示用的近似摘要，
 * 不是结构化转换。
 */
export function extractRevisionTextPreview(
  body: string,
  maxChars: number = REVISION_TEXT_PREVIEW_MAX_CHARS,
): string {
  const parts: string[] = [];
  let inFence = false;
  for (const rawLine of body.split("\n")) {
    // 统一去掉行尾 \r：预览是展示用纯文本，行尾风格由 manifest.lineEnding 记录。
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      continue;
    }
    const text = inFence
      ? line.trim()
      : stripInlineMarkers(stripBlockMarkers(line));
    if (text !== "") parts.push(text);
  }
  const joined = parts.join(" ").replace(/\s+/g, " ").trim();
  return joined.length > maxChars ? joined.slice(0, maxChars) : joined;
}
