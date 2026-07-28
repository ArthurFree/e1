/**
 * 偏好更新竞态回归测试（R003 阶段 0 基线，阶段 3 偏好事务化的验收标准）：
 * 主题、侧栏宽度、路由三类更新并发发起时不得互相覆盖。
 *
 * 当前实现的缺陷：preferencesRepository.update 是跨 await 的读-改-写，
 * 三个并发 update 从同一旧基线合并后，只有最后一次 put 生效。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useApp } from "./AppState";
import { TestApp } from "../test/TestApp";
import { resetDB } from "../infrastructure/db";
import { preferencesRepository } from "../infrastructure/repositories";

let host: { app: ReturnType<typeof useApp> | null };

function Probe() {
  host.app = useApp();
  return null;
}

describe("偏好并发更新", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
    host = { app: null };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("主题/侧栏宽度/路由并发更新互不覆盖", async () => {
    render(
      <TestApp>
        <Probe />
      </TestApp>,
    );
    await waitFor(() => expect(host.app?.ready).toBe(true), { timeout: 3000 });

    // 强制三个更新从同一旧基线合并：任何读-改-写实现都必然互相覆盖；
    // 事务化/串行化实现不经过该 get，mock 对其无影响。
    const base = await preferencesRepository.get();
    const spy = vi.spyOn(preferencesRepository, "get").mockResolvedValue(base);

    void host.app!.setTheme("dark");
    void host.app!.setSidebarWidth(320);
    host.app!.showRecent(); // 内部持久化 lastRoute
    spy.mockRestore();

    await waitFor(
      async () => {
        const stored = await preferencesRepository.get();
        expect(stored.theme).toBe("dark");
        expect(stored.sidebarWidth).toBe(320);
        expect(stored.lastRoute ?? "").toContain("recent");
      },
      { timeout: 4000 },
    );
  }, 15000);
});
