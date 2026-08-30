// @vitest-environment node
/**
 * R009 Stage 6（Auto Update）：DesktopUpdateService 状态机测试。
 * autoUpdater 全注入 fake（事件发射器 + vi.fn），不 mock electron 模块；
 * 覆盖：未打包 unsupported 不触网、check 全状态迁移、进度转发、
 * canAutoInstall=false（macOS 未签名降级）download 为 no-op、
 * error 事件沉淀为 error 状态且不 throw、feedUrlOverride 接线。
 */
import { describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../../../shared/ipc/contracts.js";
import {
  DesktopUpdateService,
  type AutoUpdaterLike,
  type DesktopUpdateServiceDeps,
} from "./DesktopUpdateService.js";

type Listener = (payload: unknown) => void;

/** 可控 fake：记录 on 注册、可手动触发事件。 */
function createFakeAutoUpdater() {
  const listeners = new Map<string, Set<Listener>>();
  const fake = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    on(event: string, listener: Listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return fake;
    },
    checkForUpdates: vi.fn(
      async (): Promise<{ updateInfo?: { version?: string } } | null> => null,
    ),
    downloadUpdate: vi.fn(async (): Promise<unknown> => []),
    quitAndInstall: vi.fn((): void => {}),
    setFeedURL: vi.fn((_url: string): void => {}),
    emit(event: string, payload?: unknown) {
      for (const listener of listeners.get(event) ?? []) {
        listener(payload);
      }
    },
  };
  return fake;
}

function createService(
  overrides: Partial<DesktopUpdateServiceDeps> = {},
) {
  const emitted: UpdateStatus[] = [];
  const autoUpdater = createFakeAutoUpdater();
  const openExternal = vi.fn(async () => {});
  const service = new DesktopUpdateService({
    // fake 的 on 为宽签名（event: string），与 AutoUpdaterLike 的重载
    // 在严格函数类型下不可直接互赋——测试替身经断言收窄。
    autoUpdater: autoUpdater as unknown as AutoUpdaterLike,
    platform: "win32",
    isPackaged: true,
    currentVersion: "0.1.0",
    emit: (status) => emitted.push(status),
    openExternal,
    ...overrides,
  });
  return { service, autoUpdater, emitted, openExternal };
}

describe("DesktopUpdateService（R009 Stage 6）", () => {
  it("未打包（dev）→ unsupported，check/download/install 均不触 updater", async () => {
    const { service, autoUpdater } = createService({ isPackaged: false });
    expect(service.getState().state).toBe("unsupported");
    const checked = await service.check();
    expect(checked.state).toBe("unsupported");
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    await service.download();
    service.install();
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("isPackaged=true 但未注入 autoUpdater → 构造抛错（装配错误尽早暴露）", () => {
    expect(
      () =>
        new DesktopUpdateService({
          platform: "win32",
          isPackaged: true,
          currentVersion: "0.1.0",
          emit: () => {},
          openExternal: async () => {},
        }),
    ).toThrow(/autoUpdater/);
  });

  it("构造时锁定 autoDownload=false / autoInstallOnAppQuit=true，接线 feedUrlOverride", () => {
    const { autoUpdater } = createService({
      feedUrlOverride: "http://127.0.0.1:9000/feed",
    });
    expect(autoUpdater.autoDownload).toBe(false);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
    expect(autoUpdater.setFeedURL).toHaveBeenCalledWith(
      "http://127.0.0.1:9000/feed",
    );
  });

  it("check：checking →（update-available 事件）→ available，逐次推送", async () => {
    const { service, autoUpdater, emitted } = createService();
    autoUpdater.checkForUpdates.mockImplementation(async () => {
      autoUpdater.emit("update-available", { version: "0.2.0" });
      return { updateInfo: { version: "0.2.0" } };
    });
    const status = await service.check();
    expect(status.state).toBe("available");
    expect(status.latestVersion).toBe("0.2.0");
    expect(emitted.map((s) => s.state)).toEqual(["checking", "available"]);
  });

  it("check：update-not-available 事件 → not-available；无事件时按返回版本兜底", async () => {
    const { service, autoUpdater } = createService();
    autoUpdater.checkForUpdates.mockImplementation(async () => {
      autoUpdater.emit("update-not-available", { version: "0.1.0" });
      return { updateInfo: { version: "0.1.0" } };
    });
    expect((await service.check()).state).toBe("not-available");

    // 兜底分支：事件未触发时按 checkForUpdates 返回版本比较。
    const fallback = createService();
    fallback.autoUpdater.checkForUpdates.mockResolvedValue({
      updateInfo: { version: "0.2.0" },
    });
    const status = await fallback.service.check();
    expect(status.state).toBe("available");
    expect(status.latestVersion).toBe("0.2.0");
  });

  it("check 失败（reject）→ error 状态且不 throw（DIST-07）", async () => {
    const { service, autoUpdater } = createService();
    autoUpdater.checkForUpdates.mockRejectedValue(new Error("网络不可达"));
    const status = await service.check();
    expect(status.state).toBe("error");
    expect(status.errorMessage).toBe("网络不可达");
  });

  it("download：available → downloading（进度转发）→ downloaded → install 调 quitAndInstall", async () => {
    const { service, autoUpdater, emitted } = createService();
    autoUpdater.emit("update-available", { version: "0.2.0" });
    autoUpdater.downloadUpdate.mockImplementation(async () => {
      autoUpdater.emit("download-progress", { percent: 42.4 });
      autoUpdater.emit("update-downloaded", { version: "0.2.0" });
      return [];
    });
    const status = await service.download();
    expect(status.state).toBe("downloaded");
    expect(status.progressPercent).toBe(100);
    const states = emitted.map((s) => s.state);
    expect(states).toContain("downloading");
    // 起始 downloading（0%）与进度事件（42%）逐次推送。
    expect(
      emitted.some(
        (s) => s.state === "downloading" && s.progressPercent === 42,
      ),
    ).toBe(true);

    service.install();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("canAutoInstall=false（macOS 未签名降级）：download 为 no-op", async () => {
    const { service, autoUpdater } = createService({ platform: "darwin" });
    expect(service.getState().canAutoInstall).toBe(false);
    autoUpdater.emit("update-available", { version: "0.2.0" });
    const status = await service.download();
    expect(status.state).toBe("available");
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("updater error 事件 → error 状态，事件回调不 throw", async () => {
    const { service, autoUpdater } = createService();
    expect(() =>
      autoUpdater.emit("error", new Error("签名校验失败")),
    ).not.toThrow();
    expect(service.getState().state).toBe("error");
    expect(service.getState().errorMessage).toBe("签名校验失败");
  });

  it("openReleasePage 走注入的 openExternal", async () => {
    const { service, openExternal } = createService();
    await service.openReleasePage();
    expect(openExternal).toHaveBeenCalledWith(
      "https://github.com/ArthurFree/e1/releases",
    );
  });
});
