/**
 * 粘贴 Markdown 检测（markdownPaste）测试：
 * - looksLikeMarkdown 启发式：结构信号 / 行内信号组合的命中与误报排除；
 * - handlePaste 插件：文件与富文本来源放行、未装配回调放行、
 *   命中时拦截并回传原文给宿主回调。
 */
import { describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import { buildDocumentExtensions } from "./extensions";
import {
  looksLikeMarkdown,
  MarkdownPaste,
  markdownPastePluginKey,
  type MarkdownPasteServices,
} from "./markdownPaste";

describe("looksLikeMarkdown", () => {
  it.each([
    "# 一级标题\n正文",
    "## 小节\n- 列表项",
    "- 项目一\n- 项目二",
    "1. 第一步\n2. 第二步",
    "- [ ] 待办\n- [x] 已完成",
    "> 引用内容\n> 第二行",
    "```ts\nconst a = 1;\n```",
    "| 列一 | 列二 |\n| --- | --- |\n| a | b |",
    "上文\n---\n下文",
  ])("结构信号命中：%j", (text) => {
    expect(looksLikeMarkdown(text)).toBe(true);
  });

  it("≥2 种行内信号判定为 Markdown", () => {
    expect(
      looksLikeMarkdown("请看 [文档](https://example.com) 与 **重点** 说明"),
    ).toBe(true);
    expect(looksLikeMarkdown("运行 `npm run dev` 然后访问 **本地页面**")).toBe(
      true,
    );
  });

  it.each([
    "这是一段普通的中文正文，没有任何标记语法，只是普通的句子。",
    "https://example.com/some/page?a=1&b=2",
    "短文本",
    "2026-09-13",
    "只含一种行内代码 `npm test` 的长句子不应触发转换确认弹窗",
    "",
    "   \n  ",
  ])("不误报：%j", (text) => {
    expect(looksLikeMarkdown(text)).toBe(false);
  });
});

function createEditor(services?: MarkdownPasteServices) {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [...buildDocumentExtensions(), MarkdownPaste],
    content: { type: "doc", content: [] },
  });
  if (services) {
    (editor.storage as unknown as Record<string, unknown>)
      .markdownPasteServices = services;
  }
  return editor;
}

function pasteEvent(init: {
  text?: string;
  html?: string;
  files?: File[];
}): ClipboardEvent {
  return {
    clipboardData: {
      files: init.files ?? [],
      getData: (type: string) =>
        type === "text/html" ? (init.html ?? "") : (init.text ?? ""),
    },
    preventDefault: vi.fn(),
  } as unknown as ClipboardEvent;
}

/** 直取本扩展插件调用 handlePaste（避免其他插件的 handlePaste 干扰断言）。 */
function runHandlePaste(editor: Editor, event: ClipboardEvent) {
  const plugin = markdownPastePluginKey.get(editor.state);
  return plugin?.props.handlePaste?.call(
    plugin,
    editor.view,
    event,
    Slice.empty,
  );
}

describe("MarkdownPaste 粘贴拦截", () => {
  const MARKDOWN = "# 标题\n\n- 列表项一\n- 列表项二";

  it("命中 Markdown 且已装配回调：拦截并把原文交给宿主", () => {
    const onMarkdownPaste = vi.fn();
    const editor = createEditor({ onMarkdownPaste });
    const event = pasteEvent({ text: MARKDOWN });

    expect(runHandlePaste(editor, event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(onMarkdownPaste).toHaveBeenCalledWith(MARKDOWN);
    editor.destroy();
  });

  it("命中 Markdown 但未装配回调：放行默认粘贴", () => {
    const editor = createEditor();
    const event = pasteEvent({ text: MARKDOWN });

    expect(runHandlePaste(editor, event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("剪贴板含 text/html（富文本来源）：放行默认 HTML 解析", () => {
    const onMarkdownPaste = vi.fn();
    const editor = createEditor({ onMarkdownPaste });
    const event = pasteEvent({ text: MARKDOWN, html: "<h1>标题</h1>" });

    expect(runHandlePaste(editor, event)).toBe(false);
    expect(onMarkdownPaste).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("剪贴板含文件：放行（图片归 LocalImage）", () => {
    const onMarkdownPaste = vi.fn();
    const editor = createEditor({ onMarkdownPaste });
    const event = pasteEvent({
      text: MARKDOWN,
      files: [new File(["x"], "图.png", { type: "image/png" })],
    });

    expect(runHandlePaste(editor, event)).toBe(false);
    expect(onMarkdownPaste).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("普通文本不拦截", () => {
    const onMarkdownPaste = vi.fn();
    const editor = createEditor({ onMarkdownPaste });
    const event = pasteEvent({ text: "这只是一段普通的中文文本内容。" });

    expect(runHandlePaste(editor, event)).toBe(false);
    expect(onMarkdownPaste).not.toHaveBeenCalled();
    editor.destroy();
  });
});
