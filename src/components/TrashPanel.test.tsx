import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppProvider } from "../state/AppState";
import { resetDB } from "../infrastructure/db";
import { pageRepository, workspaceRepository } from "../infrastructure/repositories";
import { TrashPanel } from "./TrashPanel";

describe("TrashPanel", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
  });

  it("回收站为空时显示空态", async () => {
    render(
      <AppProvider>
        <TrashPanel onClose={() => undefined} />
      </AppProvider>,
    );
    expect(await screen.findByText("回收站是空的。")).toBeInTheDocument();
  });

  it("恢复按钮让页面离开回收站", async () => {
    const [ws] = await workspaceRepository.list();
    const page = await pageRepository.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "待恢复",
    });
    await pageRepository.remove(page.id);

    render(
      <AppProvider>
        <TrashPanel onClose={() => undefined} />
      </AppProvider>,
    );
    const restore = await screen.findByLabelText("恢复「待恢复」");
    fireEvent.click(restore);
    expect(await screen.findByText("回收站是空的。")).toBeInTheDocument();
  });

  it("彻底删除需要二次确认", async () => {
    const [ws] = await workspaceRepository.list();
    const page = await pageRepository.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "待删除",
    });
    await pageRepository.remove(page.id);

    render(
      <AppProvider>
        <TrashPanel onClose={() => undefined} />
      </AppProvider>,
    );
    const purge = await screen.findByLabelText("彻底删除「待删除」");
    fireEvent.click(purge);
    // 第一次点击仅进入确认态，页面仍在列表中。
    expect(screen.getByText("待删除")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("彻底删除「待删除」"));
    expect(await screen.findByText("回收站是空的。")).toBeInTheDocument();
  });
});
