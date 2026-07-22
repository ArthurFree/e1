import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppProvider, useApp } from "../../state/AppState";
import { resetDB } from "../../infrastructure/db";
import { GlobalSidebar } from "./GlobalSidebar";

/** 等 AppProvider 就绪后再渲染侧栏。 */
function ReadySidebar() {
  const { ready } = useApp();
  return ready ? <GlobalSidebar /> : null;
}

function ViewProbe() {
  const { view } = useApp();
  return <output data-testid="view">{view}</output>;
}

describe("GlobalSidebar", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
  });

  it("渲染账户行、搜索、主导航、知识库列表与底部工具区", async () => {
    render(
      <AppProvider>
        <ReadySidebar />
      </AppProvider>,
    );
    expect(await screen.findByText("个人空间")).toBeInTheDocument();
    expect(screen.getByLabelText("搜索")).toBeInTheDocument();
    expect(screen.getByLabelText("开始")).toBeInTheDocument();
    expect(screen.getByLabelText("最近")).toBeInTheDocument();
    expect(screen.getByLabelText("收藏")).toBeInTheDocument();
    expect(screen.getByLabelText("知识库「我的知识库」")).toBeInTheDocument();
    expect(screen.getByLabelText("回收站")).toBeInTheDocument();
    expect(screen.getByLabelText("设置")).toBeInTheDocument();
  });

  it("主导航切换视图", async () => {
    render(
      <AppProvider>
        <ViewProbe />
        <ReadySidebar />
      </AppProvider>,
    );
    await screen.findByLabelText("最近");
    fireEvent.click(screen.getByLabelText("最近"));
    expect(screen.getByTestId("view")).toHaveTextContent("recent");
    fireEvent.click(screen.getByLabelText("收藏"));
    expect(screen.getByTestId("view")).toHaveTextContent("favorites");
    fireEvent.click(screen.getByLabelText("开始"));
    expect(screen.getByTestId("view")).toHaveTextContent("start");
  });

  it("点击知识库切换到知识库首页", async () => {
    render(
      <AppProvider>
        <ViewProbe />
        <ReadySidebar />
      </AppProvider>,
    );
    fireEvent.click(await screen.findByLabelText("知识库「我的知识库」"));
    // switchWorkspace 为异步流程
    await waitFor(() =>
      expect(screen.getByTestId("view")).toHaveTextContent("workspace"),
    );
  });
});
