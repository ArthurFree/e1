import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppProvider, useApp } from "../state/AppState";
import { resetDB } from "../infrastructure/db";
import { RecentPage } from "./RecentPage";

function Harness() {
  const { ready, view, showRecent } = useApp();
  return (
    <>
      <output data-testid="view">{ready ? view : "loading"}</output>
      {ready && (
        <>
          <button type="button" onClick={showRecent}>
            进入最近
          </button>
          <RecentPage onOpenTree={() => undefined} />
        </>
      )}
    </>
  );
}

describe("RecentPage", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
  });

  it("显示最近编辑列表并可切换最近浏览", async () => {
    render(
      <AppProvider>
        <Harness />
      </AppProvider>,
    );
    expect(await screen.findByText(/欢迎使用/)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "编辑过" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.click(screen.getByRole("tab", { name: "浏览过" }));
    expect(await screen.findByText("尚未浏览文档")).toBeInTheDocument();
  });

  it("打开文档后出现在最近浏览中", async () => {
    render(
      <AppProvider>
        <Harness />
      </AppProvider>,
    );
    const title = await screen.findByRole("button", { name: /任务清单/ });
    fireEvent.click(title);
    await waitFor(() => {
      expect(screen.getByTestId("view").textContent).toBe("document");
    });
  });
});
