import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppProvider, useApp } from "../state/AppState";
import { resetDB } from "../infrastructure/db";
import {
  contentRepository,
  pageRepository,
  preferencesRepository,
  workspaceRepository,
} from "../infrastructure/repositories";
import { AIDraftModal } from "./AIDraftModal";

const AI_CONFIG = {
  endpoint: "https://api.example.com/v1",
  model: "test-model",
  apiKey: "sk-test",
};

function mockFetchDraft(markdown: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: markdown } }] }),
    })),
  );
}

function Harness() {
  const { ready, view } = useApp();
  return (
    <>
      <output data-testid="view">{ready ? view : "loading"}</output>
      {ready && <AIDraftModal onClose={() => undefined} />}
    </>
  );
}

async function docTitles() {
  const [ws] = await workspaceRepository.list();
  const pages = await pageRepository.listByWorkspace(ws.id);
  return pages.filter((p) => p.kind === "document").map((p) => p.title);
}

describe("AIDraftModal", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
    await preferencesRepository.update({ aiConfig: AI_CONFIG });
    mockFetchDraft("# Q3 复盘\n\n本季度完成了三项里程碑。");
  });

  it("生成预览后确认才创建文档，正文经白名单解析", async () => {
    render(
      <AppProvider>
        <Harness />
      </AppProvider>,
    );
    fireEvent.change(await screen.findByLabelText("文档主题"), {
      target: { value: "Q3 复盘" },
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: /我的知识库/ }));
    fireEvent.click(screen.getByRole("button", { name: "生成预览" }));

    // 预览出现，但尚未创建文档。
    const preview = await screen.findByLabelText("AI 生成预览");
    expect(preview).toHaveValue("# Q3 复盘\n\n本季度完成了三项里程碑。");
    expect(await docTitles()).not.toContain("Q3 复盘");

    fireEvent.click(screen.getByRole("button", { name: "确认创建" }));
    await waitFor(() => {
      expect(screen.getByTestId("view").textContent).toBe("document");
    });
    const [ws] = await workspaceRepository.list();
    const pages = await pageRepository.listByWorkspace(ws.id);
    const created = pages.find((p) => p.title === "Q3 复盘");
    expect(created).toBeDefined();
    const content = await contentRepository.get(created!.id);
    expect(content?.textSnapshot).toContain("本季度完成了三项里程碑");
    // Markdown 标题经解析为结构化内容，不是原文。
    expect(JSON.stringify(content?.contentJson)).toContain("heading");
  });

  it("取消流程不创建文档", async () => {
    render(
      <AppProvider>
        <Harness />
      </AppProvider>,
    );
    fireEvent.change(await screen.findByLabelText("文档主题"), {
      target: { value: "不要创建" },
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: /我的知识库/ }));
    fireEvent.click(screen.getByRole("button", { name: "生成预览" }));
    await screen.findByLabelText("AI 生成预览");

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(await docTitles()).not.toContain("不要创建");
  });

  it("生成失败时显示错误且不创建文档", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );
    render(
      <AppProvider>
        <Harness />
      </AppProvider>,
    );
    fireEvent.change(await screen.findByLabelText("文档主题"), {
      target: { value: "失败案例" },
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: /我的知识库/ }));
    fireEvent.click(screen.getByRole("button", { name: "生成预览" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/不可用|失败/);
    expect(await docTitles()).not.toContain("失败案例");
  });
});
