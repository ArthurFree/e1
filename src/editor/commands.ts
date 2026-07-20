import type { Editor, Range } from "@tiptap/core";

/** 统一命令定义：驱动 / 命令菜单，后续浮动工具栏与块菜单复用同一注册表。 */
export interface EditorCommand {
  id: string;
  title: string;
  keywords: string[];
  group: "基础" | "列表" | "插入" | "媒体";
  run(editor: Editor, range?: Range): void;
}

function apply(editor: Editor, range: Range | undefined, fn: () => void) {
  if (range) editor.chain().focus().deleteRange(range).run();
  fn();
}

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
    id: "inlineMath",
    title: "行内公式",
    keywords: ["math", "gongshi", "katex", "latex"],
    group: "插入",
    run: (e, r) => apply(e, r, () => e.chain().focus().insertInlineMath({ latex: "" }).run()),
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
