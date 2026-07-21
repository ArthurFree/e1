import { useEffect, useRef } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppProvider, useApp } from "../state/AppState";
import { resetDB } from "../infrastructure/db";
import { WorkspaceHome } from "./WorkspaceHome";

function Harness() {
  const { ready, view, showWorkspaceHome } = useApp();
  const entered = useRef(false);
  useEffect(() => {
    if (ready && !entered.current) {
      entered.current = true;
      showWorkspaceHome();
    }
  }, [ready, showWorkspaceHome]);
  return (
    <>
      <output data-testid="view">{ready ? view : "loading"}</output>
      {ready && <WorkspaceHome onOpenTree={() => undefined} />}
    </>
  );
}

describe("WorkspaceHome", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
  });

  it("显示知识库头部、统计与完整目录概览", async () => {
    render(
      <AppProvider>
        <Harness />
      </AppProvider>,
    );
    expect(await screen.findByText("我的知识库")).toBeInTheDocument();
    // 种子数据：3 篇文档（分组不计入），总字数大于 0。
    expect(screen.getByText("3 篇文档")).toBeInTheDocument();
    expect(screen.getByText(/共 [\d,]+ 字/)).toBeInTheDocument();
    // 分组作为分段标题，文档带相对时间。
    expect(screen.getByRole("button", { name: /产品资料/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /会议纪要示例/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /任务清单/ })).toBeInTheDocument();
  });

  it("分组可展开收起，点击文档进入编辑", async () => {
    render(
      <AppProvider>
        <Harness />
      </AppProvider>,
    );
    const groupHeader = await screen.findByRole("button", { name: /产品资料/ });
    fireEvent.click(groupHeader);
    expect(screen.queryByRole("button", { name: /会议纪要示例/ })).toBeNull();
    fireEvent.click(groupHeader);

    const doc = await screen.findByRole("button", { name: /会议纪要示例/ });
    fireEvent.click(doc);
    await waitFor(() => {
      expect(screen.getByTestId("view").textContent).toBe("document");
    });
  });

  it("收藏切换与新建分组", async () => {
    render(
      <AppProvider>
        <Harness />
      </AppProvider>,
    );
    const favorite = await screen.findByRole("button", { name: "收藏知识库" });
    fireEvent.click(favorite);
    expect(await screen.findByRole("button", { name: "取消收藏知识库" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "新建分组" }));
    expect(await screen.findByRole("button", { name: /新建分组/ })).toBeInTheDocument();
  });
});
