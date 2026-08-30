// @vitest-environment node
/**
 * R009 Stage 6（Auto Update）：update 组 IPC handler 测试。
 * IpcMainLike bus 注册 + fake DesktopUpdateService——验证五通道信封语义
 * 与 parseNoInput 拦截（带负载 → INVALID_INPUT）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  IPC_CHANNELS,
  type IpcResult,
  type UpdateStatus,
} from "../../../shared/ipc/contracts.js";
import type { DesktopUpdateService } from "../update/DesktopUpdateService.js";
import { registerUpdateHandlers } from "./update.js";
import type { IpcMainLike } from "./handler.js";

type Handler = (
  event: unknown,
  payload: unknown,
) => Promise<IpcResult<unknown>>;

let handlers: Map<string, Handler>;

const bus: IpcMainLike = {
  handle: (channel, listener) => {
    handlers.set(channel, listener as Handler);
  },
};

function call(channel: string, payload?: unknown): Promise<IpcResult<unknown>> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`handler 未注册：${channel}`);
  return handler({}, payload);
}

const IDLE: UpdateStatus = {
  state: "idle",
  currentVersion: "0.1.0",
  canAutoInstall: true,
  releasePageUrl: "https://github.com/ArthurFree/e1/releases",
};

function fakeService(): DesktopUpdateService {
  return {
    getState: vi.fn(() => ({ ...IDLE })),
    check: vi.fn(async () => ({ ...IDLE, state: "checking" as const })),
    download: vi.fn(async () => ({ ...IDLE, state: "downloading" as const })),
    install: vi.fn(),
    openReleasePage: vi.fn(async () => {}),
  } as unknown as DesktopUpdateService;
}

beforeEach(() => {
  handlers = new Map();
});

describe("update 组 IPC（R009 Stage 6）", () => {
  it("五通道透传 service 并包 ok 信封", async () => {
    const service = fakeService();
    registerUpdateHandlers(bus, { service });

    const state = await call(IPC_CHANNELS.updateGetState);
    expect(state).toEqual({ ok: true, value: IDLE });

    const checked = await call(IPC_CHANNELS.updateCheck);
    expect(checked).toEqual({
      ok: true,
      value: { ...IDLE, state: "checking" },
    });

    const downloading = await call(IPC_CHANNELS.updateDownload);
    expect(downloading).toEqual({
      ok: true,
      value: { ...IDLE, state: "downloading" },
    });

    expect(await call(IPC_CHANNELS.updateInstall)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(service.install).toHaveBeenCalledTimes(1);

    expect(await call(IPC_CHANNELS.updateOpenReleasePage)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(service.openReleasePage).toHaveBeenCalledTimes(1);
  });

  it("携带负载 → INVALID_INPUT（parseNoInput 拦截）", async () => {
    registerUpdateHandlers(bus, { service: fakeService() });
    const result = await call(IPC_CHANNELS.updateCheck, { force: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
  });
});
