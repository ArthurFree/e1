/**
 * Markdown → 可检索纯文本（R008 Stage 3 §10.3）：SearchDocument.bodyText 的
 * 唯一提取通道。零依赖、环境中立，Electron Main（扫描/重建索引）与
 * Renderer（MarkdownCodec 侧）共用同一实现，与 frontmatter.ts 双端共用
 * 先例一致。
 *
 * 提取规则（派生文本仅供搜索，不回写、不参与展示）：
 * - Frontmatter 整块剥离（title/tags 等元数据由 SearchDocument 字段承载，
 *   不混入正文索引）；
 * - 围栏代码块：保留代码文本（搜索代码内容有用），剔除 ```/~~~ 围栏行
 *   与语言标记；行内代码保留内容、去反引号；
 * - 链接保留锚文本、图片保留 alt，丢弃 URL；自动链接保留 URL 文本；
 * - 表格保留单元格文本，剔除管道符与分隔行；
 * - 标题/引用/列表/任务标记、水平线、链接引用定义、HTML 标签剔除；
 * - 强调标记（** __ * _ ~~）仅在非词内边界剔除，snake_case 等词内
 *   下划线保留；
 * - 全部空白（含换行）归一为单个空格，返回单行文本。
 *
 * 不做人名/分词等语言处理：大小写不敏感与中文匹配由搜索契约层
 * （src/application/services/SearchContract.ts）在查询时处理。
 */
import { splitFrontmatter } from "./frontmatter.js";

/** 围栏代码行：```lang 或 ~~~lang（允许至多 3 空格前导）。 */
const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})/;
/** ATX 标题标记。 */
const HEADING_MARKER = /^\s{0,3}#{1,6}\s+/;
/** 引用标记（可重复出现表示嵌套）。 */
const BLOCKQUOTE_MARKER = /^\s{0,3}>\s?/;
/** 无序/有序列表标记。 */
const LIST_MARKER = /^\s*(?:[-+*]|\d{1,9}[.)])\s+/;
/** 任务列表勾选框。 */
const TASK_MARKER = /^\[[ xX]\]\s+/;
/** 水平线与 setext 标题下划线（整行）。 */
const THEMATIC_BREAK = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,}|={3,})\s*$/;
/** 链接引用定义行：`[ref]: https://…`。 */
const LINK_REFERENCE_DEF = /^\s{0,3}\[[^\]]+\]:/;

/** 表格分隔行（含 `|` 且仅由管道/空白/冒号/连字符组成，至少一个连字符）。 */
function isTableSeparator(line: string): boolean {
  return (
    line.includes("|") &&
    /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line)
  );
}

/** 行内转换：链接/图片/代码/HTML/强调标记 → 纯文本。 */
function inlineToText(input: string): string {
  let s = input;
  // 行内代码优先：内容里的标记不再参与后续规则。
  s = s.replace(/`+([^`]+)`+/g, "$1");
  // 图片保留 alt、链接保留锚文本，丢弃目标 URL。
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1");
  // 自动链接保留 URL 文本本身。
  s = s.replace(/<((?:https?|mailto):[^>\s]+)>/gi, "$1");
  // HTML 标签（含注释）剔除。
  s = s.replace(/<[^>]+>/g, " ");
  // 强调标记只在非词内边界剔除（保留 snake_case / 2*3 这类词内符号）。
  s = s.replace(/(?<!\w)\*\*([^*]+)\*\*(?!\w)/g, "$1");
  s = s.replace(/(?<!\w)__([^_]+)__(?!\w)/g, "$1");
  s = s.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, "$1");
  s = s.replace(/(?<!\w)_([^_]+)_(?!\w)/g, "$1");
  s = s.replace(/(?<!\w)~~?([^~]+)~~?(?!\w)/g, "$1");
  // 反斜杠转义还原为字面符号。
  s = s.replace(/\\([\\`*_[\]{}()#+.!|>~-])/g, "$1");
  return s;
}

/**
 * 提取 Markdown 的可检索纯文本。输入允许 CRLF（内部先归一为 \n）。
 * 不抛异常：任何输入都产出尽力而为的纯文本。
 */
export function markdownToSearchText(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const { body } = splitFrontmatter(normalized);
  const out: string[] = [];
  let inFence = false;
  for (const rawLine of body.split("\n")) {
    if (FENCE_LINE.test(rawLine)) {
      // 围栏行本身不索引（含语言标记）；切换代码块内外状态。
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      // 代码内容原样保留（空白归一在最后统一处理）。
      out.push(rawLine);
      continue;
    }
    if (rawLine.trim() === "") continue;
    if (THEMATIC_BREAK.test(rawLine)) continue;
    if (isTableSeparator(rawLine)) continue;
    if (LINK_REFERENCE_DEF.test(rawLine)) continue;
    let line = rawLine;
    while (BLOCKQUOTE_MARKER.test(line)) {
      line = line.replace(BLOCKQUOTE_MARKER, "");
    }
    line = line.replace(HEADING_MARKER, "");
    line = line.replace(LIST_MARKER, "");
    line = line.replace(TASK_MARKER, "");
    // 表格管道符在单元格文本提取后剔除。
    line = line.replace(/\|/g, " ");
    line = inlineToText(line);
    if (line.trim() !== "") out.push(line);
  }
  return out.join("\n").replace(/\s+/g, " ").trim();
}
