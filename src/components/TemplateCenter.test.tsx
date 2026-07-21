import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppProvider, useApp } from "../state/AppState";
import { resetDB } from "../infrastructure/db";
import {
  contentRepository,
  pageRepository,
  workspaceRepository,
} from "../infrastructure/repositories";
import { TemplateCenter } from "./TemplateCenter";

function Harness() {
  const { ready, view } = useApp();
  return (
    <>
      <output data-testid="view">{ready ? view : "loading"}</output>
      {ready && <TemplateCenter onClose={() => undefined} />}
    </>
  );
}

describe("TemplateCenter", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
  });

  it("选择模板与位置后创建普通文档并打开", async () => {
    render(
      <AppProvider>
        <Harness />
      </AppProvider>,
    );
    // 六个模板卡片可见。
    expect(await screen.findByText("会议纪要")).toBeInTheDocument();
    expect(screen.getByText("周报")).toBeInTheDocument();
    expect(screen.getByText("技术方案")).toBeInTheDocument();

    fireEvent.click(screen.getByText("会议纪要"));
    const target = await screen.findByRole("menuitem", { name: /产品资料/ });
    fireEvent.click(target);

    await waitFor(() => {
      expect(screen.getByTestId("view").textContent).toBe("document");
    });
    // 创建的是普通文档：标题为模板名，正文为模板内容，位于所选分组下。
    const [ws] = await workspaceRepository.list();
    const pages = await pageRepository.listByWorkspace(ws.id);
    const created = pages.find((p) => p.title === "会议纪要");
    expect(created).toBeDefined();
    const group = pages.find((p) => p.title === "产品资料");
    expect(created?.parentId).toBe(group?.id);
    const content = await contentRepository.get(created!.id);
    expect(content?.textSnapshot).toContain("议题");
  });

  it("取消流程不创建任何文档", async () => {
    render(
      <AppProvider>
        <Harness />
      </AppProvider>,
    );
    fireEvent.click(await screen.findByText("周报"));
    await screen.findByRole("menuitem", { name: /我的知识库/ });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    const [ws] = await workspaceRepository.list();
    const pages = await pageRepository.listByWorkspace(ws.id);
    expect(pages.some((p) => p.title === "周报")).toBe(false);
  });
});
