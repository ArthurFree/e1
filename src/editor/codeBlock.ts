/**
 * 代码块扩展（对应 R001 §7.5 代码块）。
 * 在 CodeBlockLowlight 之上增加自定义 NodeView：顶部栏提供语言选择与复制按钮；
 * 高亮使用 lowlight 的 common 语法集，离线打包、无运行时网络请求。
 */
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { common, createLowlight } from "lowlight";

/** lowlight common 语法集（离线打包，无运行时网络请求）。 */
export const lowlight = createLowlight(common);

/** 代码块可选语言项：id 存入节点 language 属性，name 用于下拉展示。 */
export interface CodeLanguage {
  id: string;
  name: string;
}

/** 代码块可选语言；HTML 使用 highlight.js 的 xml 语法（lowlight common 集无独立 html 语法）。 */
export const CODE_LANGUAGES: CodeLanguage[] = [
  { id: "plaintext", name: "纯文本" },
  { id: "javascript", name: "JavaScript" },
  { id: "typescript", name: "TypeScript" },
  { id: "json", name: "JSON" },
  { id: "xml", name: "HTML" },
  { id: "css", name: "CSS" },
  { id: "bash", name: "Shell" },
  { id: "python", name: "Python" },
  { id: "c", name: "C" },
  { id: "cpp", name: "C++" },
  { id: "rust", name: "Rust" },
  { id: "java", name: "Java" },
];

const KNOWN = new Set(CODE_LANGUAGES.map((l) => l.id));

/** 未知语言回退为纯文本，不破坏正文（Markdown 导入等外部内容的语言 id 不受控）。 */
export function normalizeCodeLanguage(language: unknown): string {
  return typeof language === "string" && KNOWN.has(language) ? language : "plaintext";
}

/** 语言的展示名；未知语言经 normalize 后显示「纯文本」。 */
export function codeLanguageName(language: unknown): string {
  const id = normalizeCodeLanguage(language);
  return CODE_LANGUAGES.find((l) => l.id === id)?.name ?? "纯文本";
}

/**
 * 带语言选择与复制按钮的代码块：语言存于节点 language 属性，
 * lowlight 高亮未知语言时自动降级为纯文本渲染。
 */
export const CodeBlockWithLanguage = CodeBlockLowlight.extend({
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("div");
      dom.className = "codeblock";

      const header = document.createElement("div");
      header.className = "codeblock__header";
      // 顶栏是控件而非正文：不可编辑，也不参与选区。
      header.contentEditable = "false";

      const select = document.createElement("select");
      select.className = "codeblock__language";
      select.setAttribute("aria-label", "代码语言");
      for (const lang of CODE_LANGUAGES) {
        const option = document.createElement("option");
        option.value = lang.id;
        option.textContent = lang.name;
        select.append(option);
      }
      select.value = normalizeCodeLanguage(node.attrs.language);
      select.addEventListener("change", () => {
        const pos = typeof getPos === "function" ? getPos() : null;
        if (pos === null || pos === undefined) return;
        editor
          .chain()
          .command(({ tr }) => {
            tr.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              language: normalizeCodeLanguage(select.value),
            });
            return true;
          })
          .run();
      });

      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "codeblock__copy";
      copy.textContent = "复制";
      copy.setAttribute("aria-label", "复制代码");
      copy.title = "复制代码";
      copy.addEventListener("click", () => {
        // 只写剪贴板，不改变文档。
        void navigator.clipboard?.writeText(node.textContent).then(() => {
          copy.textContent = "已复制";
          setTimeout(() => {
            copy.textContent = "复制";
          }, 1500);
        });
      });

      header.append(select, copy);

      const pre = document.createElement("pre");
      const code = document.createElement("code");
      pre.append(code);
      dom.append(header, pre);

      return {
        dom,
        contentDOM: code,
        update(updated) {
          // 类型已变（如被转换为段落）时返回 false，交给 ProseMirror 重建 NodeView。
          if (updated.type.name !== node.type.name) return false;
          node = updated;
          select.value = normalizeCodeLanguage(updated.attrs.language);
          return true;
        },
      };
    };
  },
}).configure({
  lowlight,
  defaultLanguage: null,
});
