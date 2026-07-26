/**
 * PreferencesService 单元测试（R003 阶段 3）：
 * 串行合并、侧栏防抖、路由 last-write-wins、错误可观测且不断链。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreferencesRepository } from "../../domain/repositories";
import { DEFAULT_PREFERENCES, type Preferences } from "../../domain/types";
import { createDeferred, type Deferred } from "../../test/fixtures";
import { PreferencesService } from "./PreferencesService";

function makeRepo() {
  let stored: Preferences = { ...DEFAULT_PREFERENCES };
  const updateGates: Deferred<void>[] = [];
  const patches: Partial<Omit<Preferences, "id">>[] = [];
  const repo: PreferencesRepository = {
    async get() {
      return stored;
    },
    async update(patch) {
      patches.push(patch);
      // 每个 update 自动挂起，由测试放行，模拟慢写入以暴露并发。
      const gate = createDeferred<void>();
      updateGates.push(gate);
      await gate.promise;
      stored = { ...stored, ...patch, id: "preferences" };
      return stored;
    },
  };
  return { repo, updateGates, patches, read: () => stored };
}

describe("PreferencesService", () => {
  let errors: unknown[];
  let service: PreferencesService;
  let stub: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    errors = [];
    stub = makeRepo();
    service = new PreferencesService({
      preferences: stub.repo,
      onError: (err) => errors.push(err),
    });
  });

  it("并发更新串行合并，互不覆盖", async () => {
    const theme = service.update({ theme: "dark" });
    const width = service.update({ sidebarWidth: 320 });
    // 串行：只有第一个 update 已发起，第二个在队列中等待。
    await vi.waitFor(() => expect(stub.patches).toHaveLength(1));

    stub.updateGates[0].resolve();
    await theme;
    await vi.waitFor(() => expect(stub.patches).toHaveLength(2));

    stub.updateGates[1].resolve();
    await width;
    expect(stub.read().theme).toBe("dark");
    expect(stub.read().sidebarWidth).toBe(320);
  });

  it("路由连续导航只落盘最后一次", async () => {
    service.persistRoute("route-a");
    service.persistRoute("route-b");
    service.persistRoute("route-c");
    await vi.waitFor(() => expect(stub.patches.length).toBeGreaterThan(0));
    stub.updateGates[0].resolve();
    await vi.waitFor(() => expect(stub.read().lastRoute).toBe("route-c"));
    // 三次导航合并为一次写入。
    expect(stub.patches).toHaveLength(1);
    expect(stub.patches[0].lastRoute).toBe("route-c");
  });

  it("侧栏宽度防抖后只持久化最后一次", async () => {
    vi.useFakeTimers();
    try {
      service.updateSidebarWidthDebounced(260);
      service.updateSidebarWidthDebounced(300);
      await vi.advanceTimersByTimeAsync(300);
      expect(stub.patches).toHaveLength(1);
      expect(stub.patches[0].sidebarWidth).toBe(300);
      stub.updateGates[0].resolve();
      await vi.waitFor(() => expect(stub.read().sidebarWidth).toBe(300));
    } finally {
      vi.useRealTimers();
    }
  });

  it("写入失败经 onError 上报且队列不中断", async () => {
    const failing = service.update({ theme: "dark" });
    await vi.waitFor(() => expect(stub.patches).toHaveLength(1));
    stub.updateGates[0].reject(new Error("磁盘已满"));
    await expect(failing).rejects.toThrow("磁盘已满");
    await vi.waitFor(() => expect(errors).toHaveLength(1));

    // 队列继续：后续更新正常执行。
    const next = service.update({ sidebarWidth: 300 });
    await vi.waitFor(() => expect(stub.patches).toHaveLength(2));
    stub.updateGates[1].resolve();
    await next;
    expect(stub.read().sidebarWidth).toBe(300);
  });
});
