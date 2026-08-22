/**
 * PageTreeSidebar 操作门控组件测试（R007 阶段 4 §9）：
 * operations.page.* 为 false 的动作隐藏入口（而不是点了抛
 * NOT_IMPLEMENTED）——删除/重命名/新建/拖拽与头部新建按钮分别覆盖。
 * 缺省（webOperations 全 true）行为不变：全部入口可见。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
      page: {
        ...webOperations.page,
        document: { ...webOperations.page.document, trash: false },
      },
    });
    expect(screen.queryByRole("button", { name: "删除「无标题」" })).toBeNull();
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
      page: {
        ...webOperations.page,
        document: { ...webOperations.page.document, renameTitle: false },
      },
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
      page: {
        ...webOperations.page,
        group: { ...webOperations.page.group, create: false },
      },
    });
    expect(screen.queryByRole("button", { name: "新建分组" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "新建文档" }),
    ).toBeInTheDocument();
  });

  it("move=false 时树行不可拖拽", async () => {
    await renderSidebar({
      ...webOperations,
      page: {
        ...webOperations.page,
        document: { ...webOperations.page.document, move: false },
      },
    });
    const row = screen.getByRole("treeitem", { name: /无标题/ });
    expect(row.getAttribute("draggable")).toBe("false");
  });
});

describe("PageTreeSidebar document/group 分对象门控（R008 Stage 0）", () => {
  beforeEach(() => {
    cleanup();
    host = { app: null };
  });

  /** Desktop 语义矩阵：group.rename/group.move = false。 */
  const desktopLike: RuntimeOperations = {
    ...webOperations,
    page: {
      ...webOperations.page,
      group: { ...webOperations.page.group, rename: false, move: false },
    },
  };

  async function renderWithGroup(operations: RuntimeOperations) {
    await renderSidebar(operations);
    await host.app!.createPage("group", null);
    await waitFor(() =>
      expect(host.app!.pages.some((p) => p.kind === "group")).toBe(true),
    );
  }

  it("group.rename=false：分组行隐藏重命名按钮、F2 不触发重命名；文档行不受影响", async () => {
    await renderWithGroup(desktopLike);
    const groupTitle = host.app!.pages.find((p) => p.kind === "group")!.title;
    // 分组行：无重命名按钮；文档行：仍有。
    expect(
      screen.queryByRole("button", { name: `重命名「${groupTitle}」` }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "重命名「无标题」" }),
    ).toBeInTheDocument();
    // F2 在分组上不触发重命名输入框。
    const groupRow = screen.getByRole("treeitem", {
      name: new RegExp(groupTitle),
    });
    groupRow.focus();
    fireEvent.keyDown(groupRow, { key: "F2" });
    expect(document.querySelector(".tree-row__rename")).toBeNull();
  });

  it("group.move=false：分组行 draggable=false；文档行仍可拖拽", async () => {
    await renderWithGroup(desktopLike);
    const groupTitle = host.app!.pages.find((p) => p.kind === "group")!.title;
    const groupRow = screen.getByRole("treeitem", {
      name: new RegExp(groupTitle),
    });
    expect(groupRow.getAttribute("draggable")).toBe("false");
    const docRow = screen.getByRole("treeitem", { name: /无标题/ });
    expect(docRow.getAttribute("draggable")).toBe("true");
  });

  it("group.rename=false 时新建分组不自动进入必然失败的重命名流程", async () => {
    await renderSidebar(desktopLike);
    screen.getByRole("button", { name: "新建分组" }).click();
    await waitFor(() =>
      expect(host.app!.pages.some((p) => p.kind === "group")).toBe(true),
    );
    // 不弹出重命名输入框、不出现 NOT_IMPLEMENTED 错误条。
    expect(document.querySelector(".tree-row__rename")).toBeNull();
    expect(document.querySelector(".tree-sidebar__error")).toBeNull();
  });

  it("group.rename=true（Web 语义）：新建分组仍自动进入重命名", async () => {
    await renderSidebar();
    screen.getByRole("button", { name: "新建分组" }).click();
    await waitFor(() =>
      expect(host.app!.pages.some((p) => p.kind === "group")).toBe(true),
    );
    await waitFor(() =>
      expect(document.querySelector(".tree-row__rename")).not.toBeNull(),
    );
  });
});
