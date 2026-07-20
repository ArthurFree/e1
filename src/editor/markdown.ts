import { Editor, type JSONContent } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import Mention from "@tiptap/extension-mention";
import { buildDocumentExtensions } from "./extensions";

/**
 * Markdown 导入导出。使用与主编辑器相同的文档扩展组合，
 * 解析经编辑器白名单 schema（不注入原始 HTML）。
 * 转换器为懒加载的模块级 headless 编辑器，避免影响主编辑器行为。
 */
let converter: Editor | null = null;

function getConverter(): Editor {
  if (!converter) {
    converter = new Editor({
      extensions: [
        ...buildDocumentExtensions(),
        Mention.configure({ HTMLAttributes: { class: "mention" } }),
        Markdown,
      ],
      content: { type: "doc", content: [] },
    });
  }
  return converter;
}

function getManager() {
  const manager = getConverter().markdown;
  if (!manager) throw new Error("Markdown 转换器初始化失败");
  return manager;
}

/** Markdown 文本 → 文档 JSON；无法解析时抛中文错误。 */
export function markdownToJson(markdown: string): unknown {
  try {
    return getManager().parse(markdown);
  } catch {
    throw new Error("无法解析该 Markdown 文件");
  }
}

/** 文档 JSON → Markdown 文本。 */
export function jsonToMarkdown(contentJson: unknown): string {
  return getManager().serialize(contentJson as JSONContent);
}

/** 从文档 JSON 提取纯文本（导入后作为搜索快照，不经编辑器）。 */
export function jsonToText(contentJson: unknown): string {
  const parts: string[] = [];
  const walk = (node: JSONContent | undefined) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.text === "string") parts.push(node.text);
    for (const child of node.content ?? []) walk(child);
  };
  walk(contentJson as JSONContent);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
