/**
 * 块级缩进扩展（对应 R001 §7.4 标题、字号与缩进）。
 * 文本块（paragraph/heading）携带 indent 属性实现缩进；
 * 列表项复用 ProseMirror 原生 sink/lift 语义。
 */
import { Extension } from "@tiptap/core";

/** 缩进级数上限：margin-left 按 2em/级渲染，8 级已接近可用宽度极限（R001 §7.4）。 */
export const MAX_INDENT = 8;
/** 支持 indent 属性的文本块类型；列表项走 sink/lift，不在此列。 */
const INDENT_TYPES = ["paragraph", "heading"];

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    indentBlock: {
      /** 增加缩进：列表内降级，文本块增加 indent 属性（最大 8 级）。 */
      indent: () => ReturnType;
      /** 减少缩进：列表内升级，文本块减少 indent 属性。 */
      outdent: () => ReturnType;
    };
  }
}

/**
 * 块级缩进：paragraph/heading 携带 indent 属性（0–8，渲染为 margin-left）；
 * 列表项（listItem/taskItem）走 sink/lift。Tab/Shift+Tab 只在列表内生效，
 * 非列表文本不拦截焦点行为，也不插入制表符。
 */
export const Indent = Extension.create({
  name: "indent",

  addGlobalAttributes() {
    return [
      {
        types: INDENT_TYPES,
        attributes: {
          indent: {
            default: 0,
            // 解析外部 HTML 时容错：非数字、负数一律归零，超上限截断。
            parseHTML: (element) => {
              const value = Number(element.getAttribute("data-indent"));
              return Number.isFinite(value) && value > 0
                ? Math.min(MAX_INDENT, Math.floor(value))
                : 0;
            },
            renderHTML: (attributes) => {
              const indent = attributes.indent as number;
              if (!indent) return {};
              return {
                "data-indent": indent,
                style: `margin-left: ${indent * 2}em`,
              };
            },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      indent:
        () =>
        ({ state, commands }) => {
          const { $from } = state.selection;
          // 选区在列表项内时优先走列表降级（sink），体现列表自身的层级语义。
          for (let depth = $from.depth; depth > 0; depth -= 1) {
            const name = $from.node(depth).type.name;
            if (name === "listItem") return commands.sinkListItem("listItem");
            if (name === "taskItem") return commands.sinkListItem("taskItem");
          }
          const block = $from.node($from.depth);
          if (!INDENT_TYPES.includes(block.type.name)) return false;
          const current = (block.attrs.indent as number) ?? 0;
          if (current >= MAX_INDENT) return false;
          return commands.updateAttributes(block.type.name, { indent: current + 1 });
        },
      outdent:
        () =>
        ({ state, commands }) => {
          const { $from } = state.selection;
          // 与 indent 对称：列表项内优先升级（lift）。
          for (let depth = $from.depth; depth > 0; depth -= 1) {
            const name = $from.node(depth).type.name;
            if (name === "listItem") return commands.liftListItem("listItem");
            if (name === "taskItem") return commands.liftListItem("taskItem");
          }
          const block = $from.node($from.depth);
          if (!INDENT_TYPES.includes(block.type.name)) return false;
          const current = (block.attrs.indent as number) ?? 0;
          if (current <= 0) return false;
          return commands.updateAttributes(block.type.name, { indent: current - 1 });
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      // 只在列表内缩进；其他场景返回 false，不拦截默认焦点行为。
      Tab: () => {
        const { $from } = this.editor.state.selection;
        for (let depth = $from.depth; depth > 0; depth -= 1) {
          const name = $from.node(depth).type.name;
          if (name === "listItem" || name === "taskItem") {
            return this.editor.commands.indent();
          }
        }
        return false;
      },
      "Shift-Tab": () => {
        const { $from } = this.editor.state.selection;
        for (let depth = $from.depth; depth > 0; depth -= 1) {
          const name = $from.node(depth).type.name;
          if (name === "listItem" || name === "taskItem") {
            return this.editor.commands.outdent();
          }
        }
        return false;
      },
    };
  },
});
