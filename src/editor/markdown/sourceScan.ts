/**
 * Markdown 源文本扫描（R005 阶段 4，批次 4A）。
 *
 * 在 headless editor 解析之前/之外，对源文本做「不进入文档」的语法检测：
 * - Wiki 链接（`[[页面]]` / `[[页面#段落]]`）：schema 无对应节点/mark，
 *   按 markdown-compatibility.md 约定作为 inline 文本保留，这里负责收集
 *   目标与锚点并标记 unsupported（wiki-link），绝不静默吞掉；
 * - 原始 HTML（除白名单解析能映射为 mark 的少量 inline 标签）：标记
 *   unsupported（raw-html），正文仍经编辑器白名单 schema 解析；
 * - 脚注语法（`[^1]` / `[^1]:`）：CommonMark 不支持，标记 unsupported
 *   （footnote），其文本在正文中以纯文本形式保留。
 *
 * 所有扫描先经 maskFencedCode 屏蔽围栏代码块，避免代码示例里的
 * `[[x]]` / `<div>` 被误报。
 */

/** 围栏代码块信息行（``` 或 ~~~，允许前导空白与语言标识）。 */
const FENCE_LINE = /^\s*(```|~~~)/;

/**
 * 把围栏代码块（含围栏行）整行清空，保留行数与换行，
 * 供基于正则的源文本扫描使用。
 */
export function maskFencedCode(markdown: string): string {
  let inFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (FENCE_LINE.test(line)) {
        inFence = !inFence;
        return "";
      }
      return inFence ? "" : line;
    })
    .join("\n");
}

/**
 * 转义脚注引用/定义的开口括号（`[^1]` → `\[^1]`），围栏代码块内不处理。
 * 背景：marked 会把 `[^1]` 当作引用式链接、把 `[^1]: text` 当作链接定义，
 * 生成一个 href 为脚注文本的伪链接。转义后脚注以纯文本原样保留
 * （unsupported 检测仍基于转义前的源文本），符合「不静默删除、不建立
 * 脚注关联」的约定。
 */
export function escapeFootnoteRefs(markdown: string): string {
  let inFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (FENCE_LINE.test(line)) {
        inFence = !inFence;
        return line;
      }
      return inFence ? line : line.replace(/(?<!\\)\[\^/g, "\\[^");
    })
    .join("\n");
}

/** Wiki 链接匹配结果（target 与 anchor 分离，别名为 text）。 */
export interface WikiLinkMatch {
  /** 原文片段，如 `[[目标页#小节]]`。 */
  raw: string;
  target: string;
  anchor?: string;
  text?: string;
}

const WIKI_LINK = /\[\[([^\][|#]+?)(?:#([^\][|]+?))?(?:\|([^\][|]+?))?\]\]/g;

/** 扫描 Wiki 链接（调用方须先 maskFencedCode）。 */
export function scanWikiLinks(maskedMarkdown: string): WikiLinkMatch[] {
  const out: WikiLinkMatch[] = [];
  for (const match of maskedMarkdown.matchAll(WIKI_LINK)) {
    out.push({
      raw: match[0],
      target: match[1].trim(),
      anchor: match[2]?.trim() || undefined,
      text: match[3]?.trim() || undefined,
    });
  }
  return out;
}

/**
 * 编辑器白名单 schema 能映射的 inline HTML 标签
 * （StarterKit/Tiptap parseHTML：a→link、b/strong→bold、i/em→italic、
 * s/del→strike、code→code、u→underline、mark→highlight、sub/sup→上下标、
 * br→hardBreak、img→image、span→textStyle）。这些不算「不支持的 raw HTML」。
 */
const SUPPORTED_INLINE_TAGS = new Set([
  "a",
  "b",
  "strong",
  "i",
  "em",
  "s",
  "del",
  "code",
  "u",
  "mark",
  "sub",
  "sup",
  "br",
  "img",
  "span",
]);

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const HTML_TAG = /<\/?([a-zA-Z][a-zA-Z0-9-]*)(\s[^<>]*)?\/?>/g;

const SNIPPET_LIMIT = 120;

function truncate(snippet: string): string {
  const oneLine = snippet.replace(/\s+/g, " ").trim();
  return oneLine.length > SNIPPET_LIMIT
    ? `${oneLine.slice(0, SNIPPET_LIMIT)}…`
    : oneLine;
}

/**
 * 扫描无法映射的原始 HTML（块级标签、未知标签、HTML 注释）。
 * 返回去重后的原文片段列表（调用方须先 maskFencedCode）。
 */
export function scanRawHtml(maskedMarkdown: string): string[] {
  const snippets = new Set<string>();
  for (const match of maskedMarkdown.matchAll(HTML_COMMENT)) {
    snippets.add(truncate(match[0]));
  }
  for (const match of maskedMarkdown.matchAll(HTML_TAG)) {
    if (SUPPORTED_INLINE_TAGS.has(match[1].toLowerCase())) continue;
    snippets.add(truncate(match[0]));
  }
  return [...snippets];
}

const FOOTNOTE_REF = /\[\^([^\]]+)\]/g;

/**
 * 扫描脚注引用/定义（`[^id]` 与 `[^id]:`），返回去重片段。
 * CommonMark 无脚注语法，解析后仅以纯文本残留，需计入 unsupported。
 */
export function scanFootnotes(maskedMarkdown: string): string[] {
  const snippets = new Set<string>();
  for (const match of maskedMarkdown.matchAll(FOOTNOTE_REF)) {
    snippets.add(match[0]);
  }
  return [...snippets];
}
