import type { Editor } from "@tiptap/core";

/**
 * 格式化共享助手（编辑器内核的格式操作层，对应 R001 §7.2/§7.4）。
 * 常驻工具栏、选区工具栏、块菜单与命令注册表通过这里的同一组函数
 * 执行格式操作，避免行为分叉。
 */

/** 颜色选项：value 为 null 表示「默认」，执行时移除对应属性而非写入颜色。 */
export interface ColorOption {
  name: string;
  value: string | null;
}

/** 文字颜色板（Notion 风格低饱和配色，深浅主题下均可读）。 */
export const TEXT_COLORS: ColorOption[] = [
  { name: "默认", value: null },
  { name: "灰色", value: "#787774" },
  { name: "棕色", value: "#9F6B53" },
  { name: "橙色", value: "#D9730D" },
  { name: "黄色", value: "#CB912F" },
  { name: "绿色", value: "#448361" },
  { name: "蓝色", value: "#337EA9" },
  { name: "紫色", value: "#9065B0" },
  { name: "粉色", value: "#C14C8A" },
  { name: "红色", value: "#D44C47" },
];

/** 高亮底色板（与 TEXT_COLORS 同色相的浅底版本）。 */
export const HIGHLIGHT_COLORS: ColorOption[] = [
  { name: "默认", value: null },
  { name: "灰底", value: "#F1F1EF" },
  { name: "棕底", value: "#F3EEEE" },
  { name: "橙底", value: "#FAEBDD" },
  { name: "黄底", value: "#FBF3DB" },
  { name: "绿底", value: "#EDF3EC" },
  { name: "蓝底", value: "#E7F3F8" },
  { name: "紫底", value: "#F6F3F9" },
  { name: "粉底", value: "#FAF1F5" },
  { name: "红底", value: "#FDEBEC" },
];

/** 可选字号（px）；null 表示“默认”，移除字号属性。 */
export const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32] as const;

/**
 * 设置选区字号。
 * @param px 像素字号；null 表示恢复默认（移除 fontSize 属性，而非写死某个值）。
 */
export function setFontSize(editor: Editor, px: number | null) {
  if (px === null) editor.chain().focus().unsetFontSize().run();
  else editor.chain().focus().setFontSize(`${px}px`).run();
}

/** 当前选区字号（px 数字）；未设置返回 null。 */
export function currentFontSize(editor: Editor): number | null {
  const size = editor.getAttributes("textStyle").fontSize;
  if (typeof size !== "string") return null;
  const parsed = Number(size.replace("px", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 应用文字颜色；value 为 null 时移除颜色属性（恢复默认）。
 */
export function applyTextColor(editor: Editor, value: string | null) {
  if (value) editor.chain().focus().setColor(value).run();
  else editor.chain().focus().unsetColor().run();
}

/**
 * 应用高亮底色；value 为 null 时移除高亮（恢复默认）。
 */
export function applyHighlight(editor: Editor, value: string | null) {
  if (value) editor.chain().focus().setHighlight({ color: value }).run();
  else editor.chain().focus().unsetHighlight().run();
}

/**
 * 可通过工具栏/块菜单切换的块样式标识。
 * 与命令注册表（commands.ts）的标题/引用/代码块命令语义一致，此处供下拉展示使用。
 */
export type BlockStyle =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "heading4"
  | "heading5"
  | "heading6"
  | "blockquote"
  | "codeBlock";

/** 块样式下拉的可选项；顺序即展示顺序。 */
export const BLOCK_STYLES: { id: BlockStyle; title: string }[] = [
  { id: "paragraph", title: "正文" },
  { id: "heading1", title: "标题 1" },
  { id: "heading2", title: "标题 2" },
  { id: "heading3", title: "标题 3" },
  { id: "heading4", title: "标题 4" },
  { id: "heading5", title: "标题 5" },
  { id: "heading6", title: "标题 6" },
  { id: "blockquote", title: "引用" },
  { id: "codeBlock", title: "代码块" },
];

/**
 * 把当前块切换为指定样式（set 语义而非 toggle：重复选择不会撤销）。
 */
export function setBlockStyle(editor: Editor, style: BlockStyle) {
  const chain = editor.chain().focus();
  if (style === "paragraph") chain.setParagraph().run();
  else if (style === "blockquote") chain.setBlockquote().run();
  else if (style === "codeBlock") chain.setCodeBlock().run();
  else chain.setNode("heading", { level: Number(style.replace("heading", "")) }).run();
}

/**
 * 判断当前选区是否为指定块样式。
 * 「正文」需额外排除引用/代码块：嵌套在其中的段落本身也是 paragraph。
 */
export function isBlockStyleActive(editor: Editor, style: BlockStyle): boolean {
  if (style === "paragraph") {
    return (
      editor.isActive("paragraph") &&
      !editor.isActive("blockquote") &&
      !editor.isActive("codeBlock")
    );
  }
  if (style === "blockquote") return editor.isActive("blockquote");
  if (style === "codeBlock") return editor.isActive("codeBlock");
  return editor.isActive("heading", { level: Number(style.replace("heading", "")) });
}

/** 当前块样式的展示名；列表等场景回退为“正文”。 */
export function currentBlockStyleTitle(editor: Editor): string {
  const active = BLOCK_STYLES.find((s) => s.id !== "paragraph" && isBlockStyleActive(editor, s.id));
  return active?.title ?? "正文";
}

/** 清除行内格式（所有 mark）。 */
export function clearInlineFormat(editor: Editor) {
  editor.chain().focus().unsetAllMarks().run();
}

/** 将当前块重置为正文（解除列表/引用/代码块/标题）。 */
export function resetBlockToParagraph(editor: Editor) {
  editor.chain().focus().clearNodes().setParagraph().run();
}
