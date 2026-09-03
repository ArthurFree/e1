/**
 * R011 Stage 1：Markdown 链接目的地源码区间扫描。
 *
 * 从 extractMarkdownLinks 抽出公共底层：返回 destination 在**整篇 markdown**
 *（含 Frontmatter）中的字符偏移，供 source-preserving 改写使用。
 *
 * 偏移约定：
 * - 输入先归一 `\r\n` → `\n`；
 * - 起点/终点相对整篇 markdown（含 Frontmatter 前缀）；
 * - Frontmatter / 围栏代码 / 行内代码内的链接样例不产出。
 */
import { splitFrontmatter } from "../markdown/frontmatter.js";

/** 行内链接/图片候选起点：`[text](` 或 `![alt](`。label 不支持嵌套方括号。 */
const LINK_START = /(!)?\[([^\]\n]*)\]\(/g;

/** 围栏代码块标记行（``` 或 ~~~，允许前导空白与 info string）。 */
const FENCE_MARKER = /^\s*(```|~~~)/;

/** 行内代码 span（行内单反引号对）。 */
const INLINE_CODE = /`[^`\n]*`/g;

export interface MarkdownLinkDestinationSpan {
  /** 目的地原文（尖括号已剥离；不含题注）。 */
  href: string;
  /** 目的地在整篇 markdown 中的起止（angle 时不含两侧 `<>`）。 */
  destinationStart: number;
  destinationEnd: number;
  /** 原始目的地是否用尖括号包裹。 */
  wrapper: "bare" | "angle";
  isImage: boolean;
  /** 链接 label（不含 []）。 */
  label: string;
  /** 整条 `[...](...)` / `![...](...)` 在行内的起止（相对整篇）。 */
  start: number;
  end: number;
}

interface ScannedDestination {
  href: string;
  destStartInLine: number;
  destEndInLine: number;
  wrapper: "bare" | "angle";
  endInLine: number;
}

function scanDestination(
  line: string,
  start: number,
): ScannedDestination | null {
  let i = start;
  while (line[i] === " " || line[i] === "\t") i++;

  let href: string;
  let destStartInLine: number;
  let destEndInLine: number;
  let wrapper: "bare" | "angle";

  if (line[i] === "<") {
    const close = line.indexOf(">", i + 1);
    if (close === -1) return null;
    href = line.slice(i + 1, close);
    destStartInLine = i + 1;
    destEndInLine = close;
    wrapper = "angle";
    i = close + 1;
  } else {
    const begin = i;
    let depth = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === " " || ch === "\t") break;
      if (ch === "(") depth++;
      else if (ch === ")") {
        if (depth === 0) break;
        depth--;
      }
      i++;
    }
    href = line.slice(begin, i);
    destStartInLine = begin;
    destEndInLine = i;
    wrapper = "bare";
  }

  while (line[i] === " " || line[i] === "\t") i++;
  if (line[i] === '"' || line[i] === "'") {
    const quote = line[i];
    const close = line.indexOf(quote, i + 1);
    if (close === -1) return null;
    i = close + 1;
    while (line[i] === " " || line[i] === "\t") i++;
  }
  if (line[i] !== ")") return null;
  return {
    href,
    destStartInLine,
    destEndInLine,
    wrapper,
    endInLine: i + 1,
  };
}

function maskInlineCode(line: string): string {
  return line.replace(INLINE_CODE, (span) => " ".repeat(span.length));
}

/**
 * 计算 body 在整篇 markdown 中的起始偏移（与 splitFrontmatter 跳空行规则对齐）。
 */
function bodyStartOffset(markdown: string, body: string): number {
  if (body.length === 0) return markdown.length;
  // 无 Frontmatter：body === markdown。
  if (body === markdown) return 0;
  // 有 Frontmatter：body 是尾部切片；用「从末尾对齐」求前缀长度。
  if (markdown.endsWith(body)) {
    return markdown.length - body.length;
  }
  // 极端：正文恰好也出现在 Frontmatter 中——回退到 split 行算法。
  const lines = markdown.split("\n");
  if (lines[0]?.trim() !== "---") return 0;
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) return 0;
  let bodyStart = closeIndex + 1;
  if (lines[bodyStart]?.trim() === "") bodyStart += 1;
  if (bodyStart >= lines.length) return markdown.length;
  return lines.slice(0, bodyStart).join("\n").length + 1;
}

/**
 * 扫描 Markdown 中全部可改写链接目的地（含图片）。
 * 空 href 不产出；与 extractMarkdownLinks 取舍一致。
 */
export function scanMarkdownLinkDestinations(
  markdown: string,
): MarkdownLinkDestinationSpan[] {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const { body } = splitFrontmatter(normalized);
  const bodyOffset = bodyStartOffset(normalized, body);

  const spans: MarkdownLinkDestinationSpan[] = [];
  let inFence = false;
  let lineOffset = bodyOffset;
  const bodyLines = body.split("\n");

  for (let lineIndex = 0; lineIndex < bodyLines.length; lineIndex++) {
    const rawLine = bodyLines[lineIndex]!;
    const lineAbsStart = lineOffset;
    // 除最后一行外，split 去掉的 `\n` 计入下一行起点。
    lineOffset +=
      rawLine.length + (lineIndex < bodyLines.length - 1 ? 1 : 0);

    if (FENCE_MARKER.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const masked = maskInlineCode(rawLine);
    LINK_START.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = LINK_START.exec(masked)) !== null) {
      const scanned = scanDestination(masked, LINK_START.lastIndex);
      if (!scanned) continue;
      LINK_START.lastIndex = scanned.endInLine;
      if (scanned.href.length === 0) continue;

      const isImage = Boolean(match[1]);
      const labelStart = match.index + (isImage ? 2 : 1);
      const label = rawLine.slice(labelStart, labelStart + match[2].length);

      spans.push({
        href: scanned.href,
        destinationStart: lineAbsStart + scanned.destStartInLine,
        destinationEnd: lineAbsStart + scanned.destEndInLine,
        wrapper: scanned.wrapper,
        isImage,
        label,
        start: lineAbsStart + match.index,
        end: lineAbsStart + scanned.endInLine,
      });
    }
  }

  return spans;
}
