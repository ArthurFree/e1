/**
 * PreferencesProvider 单元测试（R004 阶段 4）：
 * - Provider 卸载时 dispose 写入服务：防抖挂起的侧栏宽度立即补写一次，
 *   越过防抖窗口后不再有延迟写入；
 * - PreferencesService.dispose 等待写入队列排空（服务级语义）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { AppProviders } from "./AppProviders";
import { AppServicesProvider } from "./AppServicesProvider";
import { createInMemoryAppServices } from "../infrastructure/memory/createInMemoryAppServices";
import {
  usePreferences,
  type PreferencesContextValue,
} from "./PreferencesContext";
import { PreferencesService } from "../application/services/PreferencesService";
import type { PreferencesRepository } from "../domain/repositories";
import { DEFAULT_PREFERENCES, type Preferences } from "../domain/types";
import { createDeferred, sleep } from "../test/fixtures";

let host: { prefs: PreferencesContextValue | null };

function Probe() {
  host.prefs = usePreferences();
  return null;
}

describe("PreferencesProvider", () => {
  beforeEach(() => {
    cleanup();
    host = { prefs: null };
  });

  it("卸载 dispose：防抖挂起的宽度补写一次，之后不再写入", async () => {
    const { services, store } = createInMemoryAppServices();
    const updateSpy = vi.spyOn(services.preferences, "update");
    const { unmount } = render(
      <AppServicesProvider services={services}>
        <AppProviders>
          <Probe />
        </AppProviders>
      </AppServicesProvider>,
    );
    await waitFor(() => expect(host.prefs).not.toBeNull());

    await act(async () => {
      await host.prefs!.setSidebarWidth(333);
    });
    // 仍在 250ms 防抖窗口内立即卸载：dispose 应补写挂起的宽度。
    unmount();
    // 越过防抖窗口：不得出现第二次（防抖定时器触发的）写入。
    await sleep(350);

    const widthWrites = updateSpy.mock.calls.filter(
      ([patch]) => "sidebarWidth" in patch,
    );
    expect(widthWrites).toHaveLength(1);
    expect(widthWrites[0][0]).toEqual({ sidebarWidth: 333 });
    expect(store.preferences.sidebarWidth).toBe(333);
    vi.restoreAllMocks();
  });

  it("dispose 等待写入队列排空", async () => {
    const gate = createDeferred<Preferences>();
    const repository: PreferencesRepository = {
      get: () => Promise.resolve({ ...DEFAULT_PREFERENCES }),
      update: () => gate.promise,
    };
    const service = new PreferencesService({ preferences: repository });
    void service.update({ theme: "dark" });

    let drained = false;
    void service.dispose().then(() => {
      drained = true;
    });
    await sleep(10);
    // 队列中的写入尚未完成，dispose 不兑现。
    expect(drained).toBe(false);

    gate.resolve({ ...DEFAULT_PREFERENCES, theme: "dark" });
    await sleep(10);
    expect(drained).toBe(true);
  });

  it("StrictMode 重挂载后写入仍然有效（dispose 后经 resume 恢复）", async () => {
    const { services, store } = createInMemoryAppServices();
    render(
      <StrictMode>
        <AppServicesProvider services={services}>
          <AppProviders>
            <Probe />
          </AppProviders>
        </AppServicesProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(host.prefs).not.toBeNull());

    // StrictMode 的「挂载 → 清理 → 再挂载」已触发过一次 dispose；
    // 之后的防抖写入（fire-and-forget 路径）必须仍然落盘。
    await act(async () => {
      await host.prefs!.setSidebarWidth(333);
    });
    await sleep(350);
    expect(store.preferences.sidebarWidth).toBe(333);
  });
});
