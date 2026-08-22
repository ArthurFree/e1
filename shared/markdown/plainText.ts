/**
 * R008 Stage 3（§10.3）：Markdown → 可搜索纯文本（bodyText 提取）。
 *
 * 环境中立、零依赖、不依赖 Tiptap——Electron Main（Stage 4 批量索引）
 * 与 Renderer 共用同一提取器（R006：Main 不得 import Tiptap/src）。
 * 原始 Markdown 语法（#、*、链接 URL、围栏等）不进入索引文本；
 * 代码块/链接文字/图片 alt/表格单元格内容保留为可搜索文本。
 *
 * 本提取器只服务搜索索引（derived data），不参与正文读写，
 * 无需与 MarkdownCodec 的往返语义对齐。
 */
import { splitFrontmatter } from "./frontmatter.js";

/** Markdown → 可搜索纯文本：剥离 Frontmatter 与语法标记，保留内容文本。 */
export function markdownToPlainText(markdown: string): string {
  const { body } = splitFrontmatter(markdown.replace(/\r\n/g, "\n"));
  const lines = body.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (const rawLine of lines) {
    const line = rawLine;
    // 围栏代码块：剥离围栏行（```/~~~ 与 info string），保留代码内容。
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      // HTML 注释整块剔除。
      if (/^\s*<!--.*-->\s*$/.test(line)) continue;
      out.push(cleanMarkdownLine(line));
    } else {
      out.push(line);
    }
  }
  return out
    .join("\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");
}

/** 单行语法清理：链接/图片/行内代码/表格/强调/标题与列表标记/HTML 标签。 */
function cleanMarkdownLine(line: string): string {
  let text = line;
  // 图片 ![alt](src) → alt（先图片后链接，避免被链接规则吃掉）。
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  // 链接 [text](url) → text；引用式链接 [text][ref] → text。
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1");
  // Wiki 链接 [[target|text]] / [[target]] → 显示文本。
  text = text.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1");
  text = text.replace(/\[\[([^\]]*)\]\]/g, "$1");
  // 自动链接 <https://…> → URL 文本本身。
  text = text.replace(/<((?:https?|mailto):[^>]*)>/g, "$1");
  // 行内代码 `code` → code。
  text = text.replace(/`([^`]*)`/g, "$1");
  // HTML 标签（成对或自闭合）剔除，保留 inner text。
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, " ");
  // 表格分隔行 |---|---| 与单元格管道符 → 空白。
  text = text.replace(/\|/g, " ");
  // 标题/引用/列表/任务列表标记。
  text = text.replace(/^\s{0,3}#{1,6}\s+/, "");
  text = text.replace(/^\s{0,3}>\s?/, "");
  text = text.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "");
  // 主题分隔线。
  text = text.replace(/^\s*([-*_])\s*(\1\s*){2,}$/, "");
  // 强调标记（** __ * _ ~~），内容保留。
  text = text.replace(/(\*\*|__|~~?)(.+?)\1/g, "$2");
  return text;
}
