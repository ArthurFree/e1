/**
 * 序列化侧文档变换与有损检测（R005 阶段 4，批次 4A）。
 *
 * 对照 docs/architecture/markdown-compatibility.md 矩阵，把无法直接交给
 * @tiptap/markdown 序列化的节点改写为安全形态，并逐条记录 unsupported：
 * - localImage：portable → `![alt](相对路径)`（路径经 MarkdownAssetResolver）；
 *   plain → 可见占位文本；宽度无法携带时记 local-image-width；
 * - attachment：portable → `[name](相对路径)` 链接段落；plain → 可见占位文本；
 * - mention（@ 页面提及）：portable 且 resolveMentionPath 命中 → 标准相对
 *   Markdown 链接；否则降级为纯文本 `@标题`（矩阵既定策略）；
 * - image（旧 Base64，src 为 data:）：无法迁移为资源文件，降级为占位文本；
 * - textStyle（颜色/字号）、subscript/superscript、textAlign、indent、
 *   表格单元格复杂内容：Markdown 无对应语法，正文保留、样式丢失并记录。
 *
 * 铁律：绝不静默丢弃节点内容——最差也降级为可见文本/占位链接（r005.md §九）。
 *
 * 已知偏差（留待后续批次评估）：portable 模式下 subscript/superscript
 * 按矩阵可用 <sub>/<sup> 内联 HTML 保留，本批暂记 unsupported 并保留纯文本。
 */
import type {
  MarkdownAssetResolver,
  UnsupportedMarkdownFeature,
} from "./types";

export interface SerializeTransformOptions {
  mode: "portable" | "plain";
  assetResolver: MarkdownAssetResolver;
  resolveMentionPath?: (pageId: string) => string | null;
}

export interface SerializeTransformResult {
  document: unknown;
  unsupported: UnsupportedMarkdownFeature[];
}

interface JsonMark {
  type: string;
  attrs?: Record<string, unknown>;
}

interface JsonNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: JsonMark[];
  content?: JsonNode[];
}

const SNIPPET_LIMIT = 80;

function snippetOf(text: string | undefined, fallback: string): string {
  const value = (text ?? "").trim() || fallback;
  return value.length > SNIPPET_LIMIT
    ? `${value.slice(0, SNIPPET_LIMIT)}…`
    : value;
}

/** 构造可见占位段落（plain 模式降级 / data: 图片降级共用）。 */
function placeholderParagraph(text: string): JsonNode {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function linkParagraph(text: string, href: string): JsonNode {
  return {
    type: "paragraph",
    content: [
      {
        type: "text",
        text,
        marks: [{ type: "link", attrs: { href, title: null } }],
      },
    ],
  };
}

/**
 * 深拷贝并按矩阵变换文档 JSON。输入不被修改。
 */
export function transformDocumentForMarkdown(
  document: unknown,
  options: SerializeTransformOptions,
): SerializeTransformResult {
  const unsupported: UnsupportedMarkdownFeature[] = [];
  const report = (entry: UnsupportedMarkdownFeature) => {
    unsupported.push(entry);
  };

  const transform = (node: JsonNode): JsonNode | null => {
    if (!node || typeof node !== "object" || typeof node.type !== "string") {
      return node ?? null;
    }

    // —— 块级资源节点 ——
    if (node.type === "localImage") {
      const attrs = node.attrs ?? {};
      const attachmentId =
        typeof attrs.attachmentId === "string" ? attrs.attachmentId : "";
      const alt = typeof attrs.alt === "string" ? attrs.alt : "";
      if (options.mode === "portable") {
        const path = options.assetResolver.resolveAssetPath({
          attachmentId,
          name: alt || attachmentId || "image",
          kind: "image",
        });
        if (typeof attrs.width === "number") {
          // 宽度和 alt 保留是目标策略（矩阵 localImage 行），但 Markdown
          // 图片语法无法携带宽度，alt 已保留、宽度记为丢失。
          report({
            kind: "local-image-width",
            snippet: snippetOf(alt, attachmentId),
            message:
              "本地图片的宽度设置无法写入 Markdown，已丢失（图片本体保留）。",
          });
        }
        return {
          type: "image",
          attrs: { src: path, alt: alt || null, title: null },
        };
      }
      report({
        kind: "local-image",
        snippet: snippetOf(alt, attachmentId),
        message: "plain 模式不导出本地图片资源，已降级为可见占位文本。",
      });
      return placeholderParagraph(`（图片：${alt || "本地图片"}）`);
    }

    if (node.type === "attachment") {
      const attrs = node.attrs ?? {};
      const attachmentId =
        typeof attrs.attachmentId === "string" ? attrs.attachmentId : "";
      const name = typeof attrs.name === "string" ? attrs.name : "";
      if (options.mode === "portable") {
        const path = options.assetResolver.resolveAssetPath({
          attachmentId,
          name: name || attachmentId || "attachment",
          kind: "attachment",
        });
        return linkParagraph(name || "附件", path);
      }
      report({
        kind: "attachment",
        snippet: snippetOf(name, attachmentId),
        message: "plain 模式不导出附件资源，已降级为可见占位文本。",
      });
      return placeholderParagraph(`（附件：${name || "附件"}）`);
    }

    // —— 行内 @ 页面提及 ——
    if (node.type === "mention") {
      const attrs = node.attrs ?? {};
      const id = typeof attrs.id === "string" ? attrs.id : "";
      const label =
        typeof attrs.label === "string" && attrs.label ? attrs.label : id;
      const path = options.resolveMentionPath?.(id) ?? null;
      if (path) {
        return {
          type: "text",
          text: label,
          marks: [{ type: "link", attrs: { href: path, title: null } }],
        };
      }
      report({
        kind: "mention",
        snippet: snippetOf(label, id),
        message:
          "@ 页面提及无法解析为 vault 内相对链接，已降级为纯文本（@标题）。",
      });
      return { type: "text", text: `@${label}` };
    }

    // —— 旧 Base64 图片（无法迁移为资源文件） ——
    if (node.type === "image" && typeof node.attrs?.src === "string") {
      const src = node.attrs.src;
      if (src.startsWith("data:")) {
        const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
        report({
          kind: "image-data-uri",
          snippet: snippetOf(alt, "data: 图片"),
          message:
            "Base64 内联图片无法迁移为资源文件，已降级为可见占位文本（图片本体未导出）。",
        });
        return placeholderParagraph(`（图片：${alt || "Base64 图片"}）`);
      }
      // 外部 URL / 相对路径图片：原样序列化。
      return { ...node, attrs: { ...node.attrs } };
    }

    // —— 递归处理子节点 ——
    const out: JsonNode = { ...node };
    if (node.attrs) out.attrs = { ...node.attrs };

    // 块级属性矩阵：textAlign / indent 无法写入 Markdown。
    if (node.type === "paragraph" || node.type === "heading") {
      const textAlign = node.attrs?.textAlign;
      if (typeof textAlign === "string" && textAlign !== "left") {
        report({
          kind: "text-align",
          snippet: snippetOf(collectText(node), textAlign),
          message: `对齐方式（${textAlign}）无法写入 Markdown，已丢失（正文保留）。`,
        });
      }
      const indent = node.attrs?.indent;
      if (typeof indent === "number" && indent > 0) {
        report({
          kind: "indent",
          snippet: snippetOf(collectText(node), String(indent)),
          message: "段落缩进无法写入 Markdown，已丢失（正文保留）。",
        });
      }
    }

    // 表格单元格内的复杂块级内容（矩阵 table 行：降级为纯文本）。
    if (node.type === "tableCell" || node.type === "tableHeader") {
      const hasComplexBlock = (node.content ?? []).some(
        (child) => child.type !== "paragraph",
      );
      if (hasComplexBlock) {
        report({
          kind: "table-cell-content",
          snippet: snippetOf(collectText(node), "表格单元格"),
          message: "表格单元格内的非段落块级内容将降级为纯文本。",
        });
      }
    }

    // Mark 矩阵：textStyle 颜色/字号与上下标无 Markdown 语法（样式丢失、正文保留）。
    if (Array.isArray(node.marks)) {
      for (const mark of node.marks) {
        if (mark.type === "textStyle") {
          const hasStyle =
            typeof mark.attrs?.color === "string" ||
            typeof mark.attrs?.fontSize === "string";
          if (hasStyle) {
            report({
              kind: "text-style",
              snippet: snippetOf(node.text, "文本样式"),
              message:
                "文字颜色/字号为 Web 增强样式，Markdown 不保留（正文保留）。",
            });
          }
        }
        if (mark.type === "subscript" || mark.type === "superscript") {
          report({
            kind: mark.type,
            snippet: snippetOf(node.text, mark.type),
            message: "上标/下标样式无法写入 Markdown，已保留为普通文本。",
          });
        }
      }
      out.marks = node.marks.map((mark) => ({ ...mark }));
    }

    if (Array.isArray(node.content)) {
      out.content = node.content
        .map((child) => transform(child))
        .filter((child): child is JsonNode => child !== null);
    }
    return out;
  };

  const transformed = transform(document as JsonNode);
  return {
    document: transformed ?? { type: "doc", content: [] },
    unsupported,
  };
}

/** 提取节点子树的纯文本（unsupported snippet 用）。 */
function collectText(node: JsonNode): string {
  const parts: string[] = [];
  const walk = (current: JsonNode) => {
    if (typeof current.text === "string") parts.push(current.text);
    for (const child of current.content ?? []) walk(child);
  };
  walk(node);
  return parts.join("");
}
