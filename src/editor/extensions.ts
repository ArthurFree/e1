import StarterKit from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extensions";
import { TextStyleKit } from "@tiptap/extension-text-style";
import Highlight from "@tiptap/extension-highlight";
import TextAlign from "@tiptap/extension-text-align";
import Image from "@tiptap/extension-image";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import Typography from "@tiptap/extension-typography";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { TableKit } from "@tiptap/extension-table";
import Mention from "@tiptap/extension-mention";
import Mathematics from "@tiptap/extension-mathematics";
import type { AnyExtension, Editor } from "@tiptap/core";
import type { Page } from "../domain/types";
import { createMentionSuggestion } from "./mentionSuggestion";
import { createSlashSuggestion } from "./slashSuggestion";

export interface EditorExtensionsOptions {
  /** @ 提及候选：当前工作区的文档页面。 */
  mentionPages: Page[];
  /** 延迟取 editor：@ 弹层在交互时才需要实例。 */
  getEditor(): Editor;
}

/**
 * 文档结构扩展（无交互部件）。主编辑器与 Markdown 转换器共用，
 * 保证导出/导入的 schema 与编辑器一致。
 */
export function buildDocumentExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false, autolink: true },
      codeBlock: { defaultLanguage: null },
    }),
    TextStyleKit,
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    Typography,
    Image.configure({ inline: false, allowBase64: true }),
    Subscript,
    Superscript,
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    Mathematics,
  ];
}

/**
 * 编辑器扩展组合。只含开源扩展；
 * TableOfContents 与 UniqueID 为 Pro 能力，目录由 src/editor/toc.ts 自行实现。
 */
export function buildEditorExtensions(options: EditorExtensionsOptions): AnyExtension[] {
  return [
    ...buildDocumentExtensions(),
    Placeholder.configure({ placeholder: "输入正文，键入 / 打开命令菜单" }),
    Mention.configure({
      HTMLAttributes: { class: "mention" },
      suggestion: createMentionSuggestion(() => options.mentionPages, options.getEditor),
    }),
    createSlashSuggestion(),
  ];
}
