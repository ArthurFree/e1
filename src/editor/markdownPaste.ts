/**
 * 粘贴 Markdown 检测与转换确认（编辑器内核侧）。
 *
 * 纯文本粘贴命中 Markdown 启发式时拦截默认粘贴，经 editor.storage
 * 注入的回调通知宿主组件弹确认框（组件↔扩展通信沿用 assetServices /
 * internalLinkServices 的 storage 通道模式，editor 层不 import components）。
 * 确认转换后由宿主经 markdownToJson 白名单解析插入；保持纯文本则由宿主
 * 调 view.pasteText 复刻默认粘贴。
 *
 * 不拦截：含文件的粘贴（图片归 LocalImage）、含 text/html 的富文本来源
 * 粘贴（默认 HTML 解析保真度更高）。
 */
import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/** 粘贴拦截插件 key（测试经它取插件断言行为）。 */
export const markdownPastePluginKey = new PluginKey("markdownPaste");

/** 宿主注入的粘贴回调（DocumentEditor 经 editor.storage 装配）。 */
export interface MarkdownPasteServices {
  /** 命中 Markdown 启发式的纯文本粘贴；宿主弹确认框决定转换或原样插入。 */
  onMarkdownPaste(text: string): void;
}

/** 从 editor.storage 读取宿主注入的粘贴回调；未装配返回 null（放行默认粘贴）。 */
function getMarkdownPasteServices(editor: Editor): MarkdownPasteServices | null {
  return (
    ((editor.storage as unknown as Record<string, unknown>)
      .markdownPasteServices as MarkdownPasteServices | undefined) ?? null
  );
}

/** 行首结构信号：任一命中即为强信号。 */
const STRUCTURAL_PATTERNS: RegExp[] = [
  /^#{1,6}\s+\S/m, // 标题
  /^```/m, // 围栏代码块
  /^\s*[-*+]\s+\[[ xX]\]\s+\S/m, // 任务列表（先于普通列表，避免重复计数）
  /^\s*[-*+]\s+\S/m, // 无序列表
  /^\s*\d+\.\s+\S/m, // 有序列表
  /^>\s?\S/m, // 引用
  /^\|?[^\n|]*\|[^\n|]*\|\s*$/m, // 表格行（含竖线分隔）
  /^\s*(-{3,}|\*{3,})\s*$/m, // 水平线
];

/** 行内信号：需 ≥2 种才判定（单个 `code` 或 **bold** 误报率太高）。 */
const INLINE_PATTERNS: RegExp[] = [
  /!?\[[^\]\n]+\]\([^)\n]+\)/, // 链接 / 图片
  /\*\*[^*\n]+\*\*/, // 加粗
  /~~[^~\n]+~~/, // 删除线
  /`[^`\n]+`/, // 行内代码
];

/**
 * 启发式判断一段纯文本是否疑似 Markdown。
 * 判定：命中 ≥1 个行首结构信号，或 ≥2 种行内信号。
 * 排除：空白、单行短文本、纯 URL——降低普通文本与链接粘贴的误报。
 */
export function looksLikeMarkdown(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // 单行短文本没有可靠结构信号，不值得打扰用户。
  if (!trimmed.includes("\n") && trimmed.length < 20) return false;
  // 纯 URL 粘贴交给默认行为（链接扩展的 autolink）。
  if (/^https?:\/\/\S+$/i.test(trimmed)) return false;
  if (STRUCTURAL_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
  const inlineKinds = INLINE_PATTERNS.filter((pattern) =>
    pattern.test(trimmed),
  ).length;
  return inlineKinds >= 2;
}

/**
 * 粘贴 Markdown 检测扩展：命中启发式时经 storage 回调交给宿主弹确认框。
 * 未装配回调（如转换器/单测环境）或剪贴板含文件/HTML 时放行默认粘贴。
 */
export const MarkdownPaste = Extension.create({
  name: "markdownPaste",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: markdownPastePluginKey,
        props: {
          handlePaste: (_view, event) => {
            const clipboard = event.clipboardData;
            if (!clipboard) return false;
            // 文件粘贴归 LocalImage（附件化插入），此处不抢。
            if (clipboard.files && clipboard.files.length > 0) return false;
            // 富文本来源（含 text/html）走默认 HTML 解析，不按 Markdown 处理。
            if (clipboard.getData("text/html")) return false;
            const text = clipboard.getData("text/plain");
            if (!looksLikeMarkdown(text)) return false;
            const services = getMarkdownPasteServices(this.editor);
            if (!services) return false;
            event.preventDefault();
            services.onMarkdownPaste(text);
            return true;
          },
        },
      }),
    ];
  },
});
