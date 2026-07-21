import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { AppProvider } from "../../state/AppState";
import { resetDB } from "../../infrastructure/db";
import { preferencesRepository } from "../../infrastructure/repositories";
import { buildEditorExtensions } from "../../editor/extensions";
import { openAIAssistant } from "../../editor/aiBridge";
import { AIAssistantPanel } from "./AIAssistantPanel";

function createEditor(text: string) {
  const holder: { editor: Editor | null } = { editor: null };
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: buildEditorExtensions({
      mentionPages: [],
      getEditor: () => holder.editor as Editor,
    }),
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    },
  });
  holder.editor = editor;
  return editor;
}

function mockFetchResult(content: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

describe("AIAssistantPanel", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("未配置 AI 时安全降级，提供设置入口", async () => {
    const editor = createEditor("正文");
    render(
      <AppProvider>
        <AIAssistantPanel editor={editor} />
      </AppProvider>,
    );
    act(() => openAIAssistant({ mode: "ask", from: 1, to: 1 }));
    expect(await screen.findByText(/尚未配置 AI 服务/)).toBeInTheDocument();
    expect(screen.getByText("打开设置")).toBeInTheDocument();
    editor.destroy();
  });

  it("ask 模式：提问后预览结果，应用后插入文档", async () => {
    await preferencesRepository.update({
      aiConfig: { endpoint: "https://example.com/v1", model: "test", apiKey: "sk" },
    });
    mockFetchResult("AI 回答内容");
    const editor = createEditor("正文");
    render(
      <AppProvider>
        <AIAssistantPanel editor={editor} />
      </AppProvider>,
    );
    const end = editor.state.doc.content.size;
    act(() => openAIAssistant({ mode: "ask", from: end, to: end }));

    fireEvent.change(await screen.findByLabelText("向 AI 提问"), {
      target: { value: "这是什么？" },
    });
    fireEvent.click(screen.getByText("发送"));

    expect(await screen.findByLabelText("AI 生成结果预览")).toHaveTextContent(
      "AI 回答内容",
    );
    fireEvent.click(screen.getByText("应用"));
    expect(editor.getText()).toContain("AI 回答内容");
    editor.destroy();
  });

  it("polish 模式：应用后替换原选区", async () => {
    await preferencesRepository.update({
      aiConfig: { endpoint: "https://example.com/v1", model: "test", apiKey: "sk" },
    });
    mockFetchResult("润色后的文字");
    const editor = createEditor("这是一段需要润色的文字");
    render(
      <AppProvider>
        <AIAssistantPanel editor={editor} />
      </AppProvider>,
    );
    act(() =>
      openAIAssistant({ mode: "polish", selection: "需要润色", from: 5, to: 9 }),
    );

    expect(await screen.findByLabelText("AI 生成结果预览")).toHaveTextContent(
      "润色后的文字",
    );
    fireEvent.click(screen.getByText("应用"));
    const text = editor.getText();
    expect(text).toContain("润色后的文字");
    expect(text).not.toContain("需要润色");
    editor.destroy();
  });

  it("请求失败时显示错误并可重试", async () => {
    await preferencesRepository.update({
      aiConfig: { endpoint: "https://example.com/v1", model: "test", apiKey: "sk" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );
    const editor = createEditor("正文");
    render(
      <AppProvider>
        <AIAssistantPanel editor={editor} />
      </AppProvider>,
    );
    act(() => openAIAssistant({ mode: "summarize", selection: "正文", from: 1, to: 3 }));
    expect(await screen.findByText("API Key 无效或没有权限")).toBeInTheDocument();
    expect(screen.getByText("重试")).toBeInTheDocument();
    editor.destroy();
  });
});
