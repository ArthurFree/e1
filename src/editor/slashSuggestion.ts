/**
 * `/` 斜杠命令建议（编辑器内核的主要交互入口）。
 * 基于 @tiptap/suggestion：键入 `/` 弹出命令菜单，查询实时过滤
 * commands.ts 的统一命令注册表（R001 §7.3 命令统一：同一注册表驱动多个入口）；
 * 选中后由 Suggestion 计算出覆盖触发文本的 range，命令内部先删除该 range 再执行。
 */
import { Extension, type Editor, type Range } from "@tiptap/core";
import { Suggestion } from "@tiptap/suggestion";
import { filterCommands } from "./commands";
import { createPopupRenderer, type CommandListItem } from "./popupRenderer";
import { CommandList } from "../components/editor/CommandList";

/** 命令菜单条目：展示字段（CommandListItem）加选中时的执行函数。 */
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
              // 副标题复用命令分组名，弹层按它展示归属分区。
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
