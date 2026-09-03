/**
 * R010 Stage 2（§10）：索引侧链接提取——从 Markdown 源文本提取链接。
 *
 * 环境中立、零依赖（仅依赖 ../markdown/frontmatter.js 与 ./linkKind.js）。
 * Electron Main 扫描 Vault 时对每个 .md 文件运行，与保存侧
 * ./extractDocumentLinks.js（Tiptap JSON）输出一致，由
 * src/editor/markdown/extractLinksConsistency.test.ts 契约测试锁定。
 *
 * 提取规则：
 * - 先剥离 Frontmatter（splitFrontmatter），再逐行扫描；
 * - 围栏代码块（```/~~~）整段屏蔽，块内链接样例不产出；
 * - 行内代码 `…` 内的链接样例同样屏蔽（替换为等长空白，保持偏移）；
 * - 识别 `[text](href)` 与 `![alt](src)`；目的地支持平衡括号
 *   （`fn(1).md`）与尖括号包裹的空格路径（`<my note.md>`，输出剥离尖括号），
 *   可选 `"title"`/`'title'` 题注被忽略；
 * - 与 codec（marked）保持一致的取舍：裸空格目的地（`[a](my note.md)`）
 *   不是合法链接，不产出；引用式链接 `[a][1]`、自动链接 `<https://…>`、
 *   Wiki 链接 `[[a]]` 不识别（codec 序列化产物不含这些形态）；
 * - 空 href（`[a]()`）不产出条目。
 */
import { splitFrontmatter } from "../markdown/frontmatter.js";
import {
  buildExtractedLink,
  type ExtractedLink,
} from "./extractDocumentLinks.js";

/** 行内链接/图片候选起点：`[text](` 或 `![alt](`。label 不支持嵌套方括号。 */
const LINK_START = /(!)?\[([^\]\n]*)\]\(/g;

/** 围栏代码块标记行（``` 或 ~~~，允许前导空白与 info string）。 */
const FENCE_MARKER = /^\s*(```|~~~)/;

/** 行内代码 span（行内单反引号对）。 */
const INLINE_CODE = /`[^`\n]*`/g;

interface ScannedDestination {
  /** 目的地原文（尖括号形式已剥离括号，题注已忽略）。 */
  href: string;
  /** 闭合 `)` 之后的位置。 */
  end: number;
}

/**
 * 从 `(` 之后扫描链接目的地与可选题注，直到闭合 `)`。
 * 与 marked 的取舍一致：裸空白结束目的地（其后只允许题注），
 * 平衡括号计入目的地，尖括号形式允许空格。失败返回 null。
 */
function scanDestination(
  line: string,
  start: number,
): ScannedDestination | null {
  let i = start;
  while (line[i] === " " || line[i] === "\t") i++;

  let href: string;
  if (line[i] === "<") {
    const close = line.indexOf(">", i + 1);
    if (close === -1) return null;
    href = line.slice(i + 1, close);
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
  }

  while (line[i] === " " || line[i] === "\t") i++;
  // 可选题注："..." 或 '...'，忽略其内容。
  if (line[i] === '"' || line[i] === "'") {
    const quote = line[i];
    const close = line.indexOf(quote, i + 1);
    if (close === -1) return null;
    i = close + 1;
    while (line[i] === " " || line[i] === "\t") i++;
  }
  if (line[i] !== ")") return null;
  return { href, end: i + 1 };
}

/** 把行内代码 span 替换为等长空白（保持字符偏移，label 可回切原文）。 */
function maskInlineCode(line: string): string {
  return line.replace(INLINE_CODE, (span) => " ".repeat(span.length));
}

/** 从 Markdown 源文本提取链接（knownTargetPageId 恒为 null）。 */
export function extractMarkdownLinks(
  markdown: string,
  sourceRelativePath: string,
): ExtractedLink[] {
  const { body } = splitFrontmatter(markdown.replace(/\r\n/g, "\n"));
  const links: ExtractedLink[] = [];
  let inFence = false;

  for (const rawLine of body.split("\n")) {
    if (FENCE_MARKER.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // masked 与 rawLine 等长：定位在 masked 上进行，label 从原行回切原文。
    const masked = maskInlineCode(rawLine);
    LINK_START.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = LINK_START.exec(masked)) !== null) {
      const scanned = scanDestination(masked, LINK_START.lastIndex);
      if (!scanned) continue;
      LINK_START.lastIndex = scanned.end;
      const labelStart = match.index + (match[1] ? 2 : 1);
      const label = rawLine.slice(labelStart, labelStart + match[2].length);
      const link = buildExtractedLink(scanned.href, label, sourceRelativePath);
      if (link) links.push(link);
    }
  }
  return links;
}
