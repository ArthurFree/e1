import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppProvider, useApp } from "../state/AppState";
import { resetDB } from "../infrastructure/db";
import { StartPage } from "./StartPage";

function Harness() {
  const { ready, view, selectedPageId } = useApp();
  return (
    <>
      <output data-testid="view">{ready ? view : "loading"}</output>
      <output data-testid="page">{selectedPageId ?? ""}</output>
      {ready && <StartPage onOpenTree={() => undefined} />}
    </>
  );
}

describe("StartPage", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
  });

  it("显示四个快速入口与编辑过活动列表", async () => {
    render(
      <AppProvider>
        <Harness />
      </AppProvider>,
    );
    expect(await screen.findByText("新建文档")).toBeInTheDocument();
    expect(screen.getByText("新建知识库")).toBeInTheDocument();
    expect(screen.getByText("模板中心")).toBeInTheDocument();
    expect(screen.getByText("AI 帮你写")).toBeInTheDocument();

    // 编辑过列表跨知识库展示种子文档，归属含分组路径。
    expect(await screen.findByText(/欢迎使用/)).toBeInTheDocument();
    expect(screen.getByText("我的知识库 / 产品资料")).toBeInTheDocument();
  });

  it("浏览过页签在无浏览记录时显示空态", async () => {
    render(
      <AppProvider>
        <Harness />
      </AppProvider>,
    );
    await screen.findByText(/欢迎使用/);
    fireEvent.click(screen.getByRole("tab", { name: "浏览过" }));
    expect(await screen.findByText("尚未浏览文档")).toBeInTheDocument();
  });

  it("点击新建文档主区域在最近知识库创建并打开", async () => {
    render(
      <AppProvider>
        <Harness />
      </AppProvider>,
    );
    // 等待最近使用标记落地（lastOpenedAt 异步写入后提示文案变化）。
    const create = await screen.findByRole("button", {
      name: /新建文档.*我的知识库/,
    });
    fireEvent.click(create);
    await waitFor(() => {
      expect(screen.getByTestId("view").textContent).toBe("document");
    });
    expect(screen.getByTestId("page").textContent).not.toBe("");
  });

  it("下拉选择目标分组创建文档", async () => {
    render(
      <AppProvider>
        <Harness />
      </AppProvider>,
    );
    const caret = await screen.findByRole("button", { name: "选择目标知识库或分组" });
    fireEvent.click(caret);
    const group = await screen.findByRole("menuitem", { name: /产品资料/ });
    fireEvent.click(group);
    await waitFor(() => {
      expect(screen.getByTestId("view").textContent).toBe("document");
    });
  });

  it("点击归属路径定位到知识库", async () => {
    render(
      <AppProvider>
        <Harness />
      </AppProvider>,
    );
    const path = await screen.findByText("我的知识库 / 产品资料");
    fireEvent.click(path);
    await waitFor(() => {
      expect(screen.getByTestId("view").textContent).toBe("workspace");
    });
    expect(screen.getByTestId("page").textContent).not.toBe("");
  });
});
