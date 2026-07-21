import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { buildDocumentExtensions } from "./extensions";
import { CODE_LANGUAGES, codeLanguageName, normalizeCodeLanguage } from "./codeBlock";

function createEditor(content?: unknown) {
  return new Editor({
    element: document.createElement("div"),
    extensions: buildDocumentExtensions(),
    content: content as never,
  });
}

describe("代码语言", () => {
  it("未知语言回退为纯文本", () => {
    expect(normalizeCodeLanguage("python")).toBe("python");
    expect(normalizeCodeLanguage("cobol")).toBe("plaintext");
    expect(normalizeCodeLanguage(null)).toBe("plaintext");
    expect(codeLanguageName("bash")).toBe("Shell");
    expect(codeLanguageName("unknown")).toBe("纯文本");
  });

  it("覆盖需求要求的全部语言", () => {
    const names = CODE_LANGUAGES.map((l) => l.name);
    for (const required of [
      "纯文本", "JavaScript", "TypeScript", "JSON", "HTML", "CSS",
      "Shell", "Python", "C", "C++", "Rust", "Java",
    ]) {
      expect(names).toContain(required);
    }
  });
});

describe("代码块节点", () => {
  let editor: Editor | null = null;
  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("语言属性写入节点 JSON，低亮高亮生成 hljs 标记", () => {
    editor = createEditor({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "javascript" },
          content: [{ type: "text", text: "const a = 1;" }],
        },
      ],
    });
    const node = editor.getJSON().content?.[0];
    expect(node?.attrs?.language).toBe("javascript");
    expect(editor.view.dom.querySelector(".hljs-keyword")).not.toBeNull();
  });

  it("节点视图提供语言选择与复制按钮", async () => {
    editor = createEditor({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "python" },
          content: [{ type: "text", text: "print(1)" }],
        },
      ],
    });
    const select = editor.view.dom.querySelector<HTMLSelectElement>(".codeblock__language");
    expect(select?.value).toBe("python");

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const copy = editor.view.dom.querySelector<HTMLButtonElement>(".codeblock__copy");
    copy?.click();
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("print(1)");
    });
  });

  it("切换语言更新节点属性", () => {
    editor = createEditor({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "javascript" },
          content: [{ type: "text", text: "x" }],
        },
      ],
    });
    const select = editor.view.dom.querySelector<HTMLSelectElement>(".codeblock__language")!;
    select.value = "rust";
    select.dispatchEvent(new Event("change"));
    expect(editor.getJSON().content?.[0]?.attrs?.language).toBe("rust");
  });

  it("未知语言内容不报错，选择器回退纯文本", () => {
    editor = createEditor({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "cobol" },
          content: [{ type: "text", text: "DISPLAY 1" }],
        },
      ],
    });
    const select = editor.view.dom.querySelector<HTMLSelectElement>(".codeblock__language");
    expect(select?.value).toBe("plaintext");
    expect(editor.getText()).toContain("DISPLAY 1");
  });
});
