/**
 * PageTreeSidebar 操作门控组件测试（R007 阶段 4 §9；R008 Stage 0 R8-01）：
 * operations.page.* 为 false 的动作入口不存在（而不是点了抛
 * NOT_IMPLEMENTED）——document / group 分别门控删除/重命名/拖拽，
 * 头部新建按钮与新建分组后的自动改名也按矩阵门控。
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

/** 追加一个标题为「分组A」的分组并等待其出现在页面树。 */
async function createNamedGroup() {
  const group = await host.app!.createPage("group", null);
  if (!group) throw new Error("create group failed");
  await host.app!.renamePage(group.id, "分组A");
  await waitFor(() =>
    expect(host.app!.pages.some((p) => p.title === "分组A")).toBe(true),
  );
}

/** 构造 page 组局部覆盖的 operations（其余维持 webOperations 全 true）。 */
function withPageOps(page: Partial<RuntimeOperations["page"]>) {
  return { ...webOperations, page: { ...webOperations.page, ...page } };
}

describe("PageTreeSidebar 操作门控（R007 §9 / R008 R8-01）", () => {
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

  it("document.trash=false 时隐藏删除按钮，其余入口不受影响", async () => {
    await renderSidebar(
      withPageOps({
        document: { ...webOperations.page.document, trash: false },
      }),
    );
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

  it("document.renameTitle=false 时隐藏重命名按钮", async () => {
    await renderSidebar(
      withPageOps({
        document: { ...webOperations.page.document, renameTitle: false },
      }),
    );
    expect(
      screen.queryByRole("button", { name: "重命名「无标题」" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "删除「无标题」" }),
    ).toBeInTheDocument();
  });

  it("group.create=false 时隐藏头部新建分组按钮", async () => {
    await renderSidebar(
      withPageOps({ group: { ...webOperations.page.group, create: false } }),
    );
    expect(screen.queryByRole("button", { name: "新建分组" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "新建文档" }),
    ).toBeInTheDocument();
  });

  it("document.move=false 时文档行不可拖拽", async () => {
    await renderSidebar(
      withPageOps({
        document: { ...webOperations.page.document, move: false },
      }),
    );
    const row = screen.getByRole("treeitem", { name: /无标题/ });
    expect(row.getAttribute("draggable")).toBe("false");
  });

  it("group.rename=false 时分组行无重命名按钮，文档行不受影响", async () => {
    await renderSidebar(
      withPageOps({ group: { ...webOperations.page.group, rename: false } }),
    );
    await createNamedGroup();
    expect(
      screen.queryByRole("button", { name: "重命名「分组A」" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "重命名「无标题」" }),
    ).toBeInTheDocument();
  });

  it("group.move=false 时分组行不可拖拽，文档行仍可拖拽", async () => {
    await renderSidebar(
      withPageOps({ group: { ...webOperations.page.group, move: false } }),
    );
    await createNamedGroup();
    const groupRow = screen.getByRole("treeitem", { name: /分组A/ });
    const documentRow = screen.getByRole("treeitem", { name: /无标题/ });
    expect(groupRow.getAttribute("draggable")).toBe("false");
    expect(documentRow.getAttribute("draggable")).toBe("true");
  });

  it("group.rename=false 时新建分组后不自动进入行内改名，也不出现错误条", async () => {
    await renderSidebar(
      withPageOps({ group: { ...webOperations.page.group, rename: false } }),
    );
    fireEvent.click(screen.getByRole("button", { name: "新建分组" }));
    await waitFor(() =>
      expect(host.app!.pages.some((p) => p.kind === "group")).toBe(true),
    );
    expect(screen.queryByRole("textbox", { name: "重命名" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("group.rename=true（Web 缺省）时新建分组后仍自动进入行内改名", async () => {
    await renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "新建分组" }));
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "重命名" }),
      ).toBeInTheDocument(),
    );
  });

  it("group.rename=false 时 F2 在分组行上不触发重命名", async () => {
    await renderSidebar(
      withPageOps({ group: { ...webOperations.page.group, rename: false } }),
    );
    await createNamedGroup();
    const groupRow = screen.getByRole("treeitem", { name: /分组A/ });
    groupRow.focus();
    fireEvent.keyDown(groupRow, { key: "F2" });
    expect(screen.queryByRole("textbox", { name: "重命名" })).toBeNull();
  });

  it("F2 在文档行上触发重命名（document.renameTitle=true）", async () => {
    await renderSidebar();
    const documentRow = screen.getByRole("treeitem", { name: /无标题/ });
    documentRow.focus();
    fireEvent.keyDown(documentRow, { key: "F2" });
    expect(
      screen.getByRole("textbox", { name: "重命名" }),
    ).toBeInTheDocument();
  });
});
