/**
 * PageTreeSidebar 操作门控组件测试（R007 阶段 4 §9）：
 * operations.page.* 为 false 的动作隐藏入口（而不是点了抛
 * NOT_IMPLEMENTED）——删除/重命名/新建/拖拽与头部新建按钮分别覆盖。
 * 缺省（webOperations 全 true）行为不变：全部入口可见。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { AppProvider, useApp } from "../state/AppState";
import { AppServicesProvider } from "../state/AppServicesProvider";
import { createInMemoryAppServices } from "../infrastructure/memory/createInMemoryAppServices";
import { webOperations } from "../platform/web/webOperations";
import type { RuntimeOperations } from "../runtime/RuntimeOperations";
import { PageTreeSidebar } from "./PageTreeSidebar";

let host: { app: ReturnType<typeof useApp> | null };

function Probe() {
  host.app = useApp();
  return null;
}

/** 内存容器 + 覆盖操作矩阵渲染侧栏；预置一篇文档并等待会话就绪。 */
async function renderSidebar(operations?: RuntimeOperations) {
  const { services } = createInMemoryAppServices(
    operations ? { operations } : {},
  );
  render(
    <AppServicesProvider services={services}>
      <AppProvider>
        <Probe />
        <PageTreeSidebar />
      </AppProvider>
    </AppServicesProvider>,
  );
  await waitFor(() => expect(host.app?.ready).toBe(true), { timeout: 3000 });
  await host.app!.createWorkspace("我的知识库");
  await waitFor(() => expect(host.app!.workspaceStatus).toBe("ready"));
  await host.app!.createPage("document", null);
  await waitFor(() =>
    expect(host.app!.pages.some((p) => p.title === "无标题")).toBe(true),
  );
}

describe("PageTreeSidebar 操作门控（R007 §9）", () => {
  beforeEach(() => {
    cleanup();
    host = { app: null };
  });

  it("缺省全 true：行内新建/重命名/删除与头部新建文档/新建分组均可见", async () => {
    await renderSidebar();
    expect(
      screen.getByRole("button", { name: "新建文档" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "新建分组" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "删除「无标题」" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "重命名「无标题」" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "在「无标题」下新建文档" }),
    ).toBeInTheDocument();
  });

  it("trash=false 时隐藏删除按钮，其余入口不受影响", async () => {
    await renderSidebar({
      ...webOperations,
      page: { ...webOperations.page, trash: false },
    });
    expect(
      screen.queryByRole("button", { name: "删除「无标题」" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "重命名「无标题」" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "新建文档" }),
    ).toBeInTheDocument();
  });

  it("renameTitle=false 时隐藏重命名按钮", async () => {
    await renderSidebar({
      ...webOperations,
      page: { ...webOperations.page, renameTitle: false },
    });
    expect(
      screen.queryByRole("button", { name: "重命名「无标题」" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "删除「无标题」" }),
    ).toBeInTheDocument();
  });

  it("createGroup=false 时隐藏头部新建分组按钮", async () => {
    await renderSidebar({
      ...webOperations,
      page: { ...webOperations.page, createGroup: false },
    });
    expect(screen.queryByRole("button", { name: "新建分组" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "新建文档" }),
    ).toBeInTheDocument();
  });

  it("move=false 时树行不可拖拽", async () => {
    await renderSidebar({
      ...webOperations,
      page: { ...webOperations.page, move: false },
    });
    const row = screen.getByRole("treeitem", { name: /无标题/ });
    expect(row.getAttribute("draggable")).toBe("false");
  });
});
