/**
 * 命令注册表（编辑器内核的能力目录）。
 * 统一命令定义驱动 `/` 命令菜单，浮动工具栏与块菜单复用同一注册表，
 * 避免多处入口行为分叉（R001 §7.3 命令统一）。
 * 每条命令的 run 接收可选 range：来自 `/` 菜单时为触发文本区间，需先删除再执行。
 */
import type { Editor, Range } from "@tiptap/core";
import { openAIAssistant } from "./aiBridge";
import { pickAndInsertAttachment } from "./attachment";

/** 命令分组标签：决定 `/` 菜单中的分区展示。 */
export interface EditorCommand {
  /** 稳定标识，用于去重与测试引用。 */
  id: string;
  /** 菜单展示名。 */
  title: string;
  /** 额外检索词（拼音/英文），供 filterCommands 模糊匹配。 */
  keywords: string[];
  group: "基础" | "列表" | "插入" | "媒体" | "AI";
  /**
   * 执行命令。
   * @param range 来自 `/` 菜单时为触发文本区间（需先删除）；其他入口省略。
   */
  run(editor: Editor, range?: Range): void;
}

/**
 * 命令执行包装：来自 `/` 菜单时先删除触发文本（range 覆盖 `/查询词`），
 * 再执行实际命令；工具栏等入口不传 range 则直接执行。
 */
function apply(editor: Editor, range: Range | undefined, fn: () => void) {
  if (range) editor.chain().focus().deleteRange(range).run();
  fn();
}

/** 内嵌图片大小上限（base64 存入文档 JSON，过大会拖慢保存与加载）。 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 选择本地图片并以 base64 内嵌：离线可用且随文档持久化。 */
export function pickAndInsertImage(editor: Editor) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) {
      window.alert("图片超过 5MB，请压缩后再插入。");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      editor.chain().focus().setImage({ src: reader.result as string }).run();
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

/** 全部内置命令；顺序即菜单展示顺序。新增命令只需在此登记。 */
export const EDITOR_COMMANDS: EditorCommand[] = [
  {
    id: "heading1",
    title: "标题 1",
    keywords: ["h1", "biaoti", "heading"],
    group: "基础",
    run: (e, r) => apply(e, r, () => e.chain().focus().setNode("heading", { level: 1 }).run()),
  },
  {
    id: "heading2",
    title: "标题 2",
    keywords: ["h2", "biaoti", "heading"],
    group: "基础",
    run: (e, r) => apply(e, r, () => e.chain().focus().setNode("heading", { level: 2 }).run()),
  },
  {
    id: "heading3",
    title: "标题 3",
    keywords: ["h3", "biaoti", "heading"],
    group: "基础",
    run: (e, r) => apply(e, r, () => e.chain().focus().setNode("heading", { level: 3 }).run()),
  },
  {
    id: "heading4",
    title: "标题 4",
    keywords: ["h4", "biaoti", "heading"],
    group: "基础",
    run: (e, r) => apply(e, r, () => e.chain().focus().setNode("heading", { level: 4 }).run()),
  },
  {
    id: "heading5",
    title: "标题 5",
    keywords: ["h5", "biaoti", "heading"],
    group: "基础",
    run: (e, r) => apply(e, r, () => e.chain().focus().setNode("heading", { level: 5 }).run()),
  },
  {
    id: "heading6",
    title: "标题 6",
    keywords: ["h6", "biaoti", "heading"],
    group: "基础",
    run: (e, r) => apply(e, r, () => e.chain().focus().setNode("heading", { level: 6 }).run()),
  },
  {
    id: "paragraph",
    title: "正文",
    keywords: ["text", "zhengwen", "paragraph"],
    group: "基础",
    run: (e, r) => apply(e, r, () => e.chain().focus().setParagraph().run()),
  },
  {
    id: "blockquote",
    title: "引用",
    keywords: ["quote", "yinyong"],
    group: "基础",
    run: (e, r) => apply(e, r, () => e.chain().focus().toggleBlockquote().run()),
  },
  {
    id: "codeBlock",
    title: "代码块",
    keywords: ["code", "daima"],
    group: "基础",
    run: (e, r) => apply(e, r, () => e.chain().focus().toggleCodeBlock().run()),
  },
  {
    id: "divider",
    title: "分隔线",
    keywords: ["hr", "fengexian", "divider"],
    group: "基础",
    run: (e, r) => apply(e, r, () => e.chain().focus().setHorizontalRule().run()),
  },
  {
    id: "bulletList",
    title: "项目列表",
    keywords: ["ul", "liebiao", "bullet"],
    group: "列表",
    run: (e, r) => apply(e, r, () => e.chain().focus().toggleBulletList().run()),
  },
  {
    id: "orderedList",
    title: "编号列表",
    keywords: ["ol", "liebiao", "ordered"],
    group: "列表",
    run: (e, r) => apply(e, r, () => e.chain().focus().toggleOrderedList().run()),
  },
  {
    id: "taskList",
    title: "待办列表",
    keywords: ["todo", "daiban", "task", "renwu"],
    group: "列表",
    run: (e, r) => apply(e, r, () => e.chain().focus().toggleTaskList().run()),
  },
  {
    id: "table",
    title: "表格",
    keywords: ["table", "biaoge"],
    group: "插入",
    run: (e, r) =>
      apply(e, r, () =>
        e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
      ),
  },
  {
    id: "blockMath",
    title: "公式块",
    keywords: ["math", "gongshi", "katex", "latex"],
    group: "插入",
    run: (e, r) => apply(e, r, () => e.chain().focus().insertBlockMath({ latex: "" }).run()),
  },
  {
    id: "image",
    title: "图片",
    keywords: ["image", "tupian", "img", "pic"],
    group: "媒体",
    run: (e, r) => apply(e, r, () => pickAndInsertImage(e)),
  },
  {
    id: "attachment",
    title: "附件",
    keywords: ["attachment", "fujian", "file", "wenjian"],
    group: "媒体",
    run: (e, r) =>
      apply(e, r, () => {
        // pageId 由编辑器宿主写入 storage；缺失时安全跳过。
        const pageId = (e.storage as unknown as Record<string, unknown>).attachmentPageId as
          | string
          | undefined;
        if (pageId) pickAndInsertAttachment(e, pageId);
      }),
  },
  {
    id: "inlineMath",
    title: "行内公式",
    keywords: ["math", "gongshi", "katex", "latex"],
    group: "插入",
    run: (e, r) => apply(e, r, () => e.chain().focus().insertInlineMath({ latex: "" }).run()),
  },
  {
    id: "askAI",
    title: "AI 助手",
    keywords: ["ai", "ask", "gpt", "zhushou"],
    group: "AI",
    run: (e, r) =>
      apply(e, r, () => {
        const pos = e.state.selection.from;
        openAIAssistant({ mode: "ask", from: pos, to: pos });
      }),
  },
];

/** 按标题或关键词过滤命令；空查询返回全部。 */
export function filterCommands(query: string, commands: EditorCommand[] = EDITOR_COMMANDS) {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter(
    (c) =>
      c.title.toLowerCase().includes(q) ||
      c.keywords.some((k) => k.toLowerCase().includes(q)),
  );
}
