import { Extension, type Editor, type Range } from "@tiptap/core";
import { Suggestion } from "@tiptap/suggestion";
import { filterCommands } from "./commands";
import { createPopupRenderer, type CommandListItem } from "./popupRenderer";
import { CommandList } from "../components/editor/CommandList";

export type SlashItem = CommandListItem & {
  run(editor: Editor, range: Range): void;
};

/** `/` 命令建议：查询过滤统一命令注册表，选中后删除触发文本并执行命令。 */
export function createSlashSuggestion() {
  return Extension.create({
    name: "slashCommand",

    addProseMirrorPlugins() {
      const editor = this.editor;
      return [
        Suggestion<SlashItem>({
          editor,
          char: "/",
          items: ({ query }) =>
            filterCommands(query).map((c) => ({
              id: c.id,
              title: c.title,
              subtitle: c.group,
              run: c.run,
            })),
          command: ({ editor: e, range, props }) => {
            props.run(e, range);
          },
          render: () => createPopupRenderer(() => editor, CommandList),
        }),
      ];
    },
  });
}
