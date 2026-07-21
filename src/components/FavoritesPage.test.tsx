import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppProvider, useApp } from "../state/AppState";
import { resetDB } from "../infrastructure/db";
import {
  pageRepository,
  workspaceRepository,
} from "../infrastructure/repositories";
import { FavoritesPage } from "./FavoritesPage";

function Harness() {
  const { ready, view } = useApp();
  return (
    <>
      <output data-testid="view">{ready ? view : "loading"}</output>
      {ready && <FavoritesPage onOpenTree={() => undefined} />}
    </>
  );
}

describe("FavoritesPage", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
  });

  it("无收藏时显示空态", async () => {
    render(
      <AppProvider>
        <Harness />
      </AppProvider>,
    );
    expect(await screen.findByText("还没有收藏的知识库")).toBeInTheDocument();
    expect(screen.getByText("还没有收藏的文档")).toBeInTheDocument();
  });

  it("按收藏时间倒序展示知识库与文档，可取消收藏", async () => {
    // 先布置收藏数据：知识库 + 两篇文档（先收藏的任务清单排在后）。
    const [ws] = await workspaceRepository.list();
    await workspaceRepository.setFavorite(ws.id, 1000);
    const pages = await pageRepository.listByWorkspace(ws.id);
    const welcome = pages.find((p) => p.title.includes("欢迎"))!;
    const todo = pages.find((p) => p.title.includes("任务清单"))!;
    await pageRepository.setFavorite(todo.id, 2000);
    await pageRepository.setFavorite(welcome.id, 3000);

    render(
      <AppProvider>
        <Harness />
      </AppProvider>,
    );
    const welcomeBtn = (await screen.findAllByRole("button", { name: /欢迎使用/ }))[0];
    expect(screen.getAllByRole("button", { name: /任务清单/ })[0]).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /我的知识库/ })[0]).toBeInTheDocument();
    // 文档区按收藏时间倒序：欢迎（3000）在任务清单（2000）之前。
    const docSection = screen.getByLabelText("收藏的文档");
    const titles = Array.from(
      docSection.querySelectorAll(".favorites__title"),
    ).map((el) => el.textContent ?? "");
    expect(titles[0]).toContain("欢迎");
    expect(titles[1]).toContain("任务清单");

    // 取消收藏后从列表移除。
    fireEvent.click(
      screen.getByRole("button", { name: /取消收藏文档「任务清单」/ }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /任务清单/ })).toBeNull();
    });
    expect(welcomeBtn).toBeInTheDocument();
  });

  it("点击收藏的知识库进入其首页", async () => {
    const [ws] = await workspaceRepository.list();
    await workspaceRepository.setFavorite(ws.id, 1000);
    render(
      <AppProvider>
        <Harness />
      </AppProvider>,
    );
    const wsBtn = (await screen.findAllByRole("button", { name: /我的知识库/ }))[0];
    fireEvent.click(wsBtn);
    await waitFor(() => {
      expect(screen.getByTestId("view").textContent).toBe("workspace");
    });
  });
});
