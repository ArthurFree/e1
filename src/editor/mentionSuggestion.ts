import type { Editor } from "@tiptap/core";
import type { MentionOptions } from "@tiptap/extension-mention";
import type { Page } from "../domain/types";
import { createPopupRenderer, type CommandListItem } from "./popupRenderer";
import { CommandList } from "../components/editor/CommandList";

/** `@` 提及当前工作区的文档页面；editor 在弹层打开时才取用。 */
export function createMentionSuggestion(
  getPages: () => Page[],
  getEditor: () => Editor,
): MentionOptions["suggestion"] {
  return {
    char: "@",
    items: ({ query }) => {
      const q = query.trim().toLowerCase();
      return getPages()
        .filter((p) => p.kind === "document" && p.deletedAt === null)
        .filter((p) => !q || p.title.toLowerCase().includes(q))
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
          { type: "text", text: " " },
        ])
        .run();
    },
    render: () => createPopupRenderer(getEditor, CommandList),
  };
}
