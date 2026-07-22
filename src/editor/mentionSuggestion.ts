/**
 * `@` 提及建议：在文档中插入指向当前工作区其他页面的提及节点。
 * 候选页由编辑器宿主以 getPages 延迟注入，仅在弹层查询时读取，
 * 使本模块不与状态层（AppState）产生静态依赖。
 */
import type { Editor } from "@tiptap/core";
import type { MentionOptions } from "@tiptap/extension-mention";
import type { Page } from "../domain/types";
import { createPopupRenderer, type CommandListItem } from "./popupRenderer";
import { CommandList } from "../components/editor/CommandList";

/**
 * 创建 `@` 提及的 suggestion 配置。
 * @param getPages 延迟读取候选页面（弹层查询时才调用，取当前工作区页面）。
 * @param getEditor 延迟取编辑器实例（弹层渲染时才需要，避免循环依赖）。
 */
export function createMentionSuggestion(
  getPages: () => Page[],
  getEditor: () => Editor,
): MentionOptions["suggestion"] {
  return {
    char: "@",
    items: ({ query }) => {
      const q = query.trim().toLowerCase();
      return getPages()
        // 只提及文档页，排除回收站中的页面。
        .filter((p) => p.kind === "document" && p.deletedAt === null)
        .filter((p) => !q || p.title.toLowerCase().includes(q))
        // 候选最多 10 条，避免大工作区下长列表难以浏览。
        .slice(0, 10)
        .map(
          (p): CommandListItem & { label: string } => ({
            id: p.id,
            title: p.title || "无标题",
            label: p.title || "无标题",
            icon: p.icon ?? "📄",
          }),
        );
    },
    command: ({ editor, range, props }) => {
      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          { type: "mention", attrs: { id: props.id, label: props.label } },
          // 提及节点后补一个空格，便于用户直接继续输入正文。
          { type: "text", text: " " },
        ])
        .run();
    },
    render: () => createPopupRenderer(getEditor, CommandList),
  };
}
