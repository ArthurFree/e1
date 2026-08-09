// @vitest-environment node
/**
 * R006 阶段 1：Main 侧 IPC handler 分发与错误归一测试。
 * ipcMain/原生对话框全部注入 mock（registerIpcHandlers 依赖注入），
 * 验证：八个 channel 注册齐全、selectDirectory 真实行为（取消/选中）、
 * schema 校验失败归一 INVALID_INPUT/PATH_ESCAPE、契约桩归一 NOT_IMPLEMENTED。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, type IpcResult } from "../../../shared/ipc/contracts.js";
import { registerIpcHandlers } from "./index.js";
import type { IpcMainLike } from "./handler.js";
import type { OpenDialogLike } from "./vault.js";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));

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

beforeEach(() => {
  handlers = new Map();
});

describe("registerIpcHandlers 注册", () => {
  it("八个 channel 全部注册", () => {
    registerIpcHandlers({ ipc: bus });
    expect([...handlers.keys()].sort()).toEqual(
      Object.values(IPC_CHANNELS).sort(),
    );
  });
});

describe("vault.selectDirectory（真实实现，对话框 mock）", () => {
  it("取消返回 ok(null)", async () => {
    const openDialog: OpenDialogLike = {
      showOpenDialog: vi
        .fn()
        .mockResolvedValue({ canceled: true, filePaths: [] }),
    };
    registerIpcHandlers({ ipc: bus, openDialog });
    await expect(call(IPC_CHANNELS.vaultSelectDirectory)).resolves.toEqual({
      ok: true,
      value: null,
    });
  });

  it("选中目录返回 vaultId 为 null 的目录信息（basename 为展示名）", async () => {
    const showOpenDialog = vi
      .fn()
      .mockResolvedValue({ canceled: false, filePaths: ["/Users/x/我的笔记"] });
    registerIpcHandlers({ ipc: bus, openDialog: { showOpenDialog } });
    const result = await call(IPC_CHANNELS.vaultSelectDirectory);
    expect(result).toEqual({
      ok: true,
      value: {
        vaultId: null,
        absolutePath: "/Users/x/我的笔记",
        displayName: "我的笔记",
      },
    });
    expect(showOpenDialog).toHaveBeenCalledWith({
      properties: ["openDirectory", "createDirectory"],
    });
  });

  it("携带负载即 INVALID_INPUT 信封", async () => {
    registerIpcHandlers({ ipc: bus, openDialog: { showOpenDialog: vi.fn() } });
    const result = await call(IPC_CHANNELS.vaultSelectDirectory, { x: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
  });
});

describe("契约桩 NOT_IMPLEMENTED 归一", () => {
  beforeEach(() => {
    registerIpcHandlers({ ipc: bus });
  });

  it("vault.scan 合法入参 → NOT_IMPLEMENTED 线格式", async () => {
    const result = await call(IPC_CHANNELS.vaultScan, "v1");
    expect(result).toEqual({
      ok: false,
      error: {
        code: "NOT_IMPLEMENTED",
        message: expect.stringContaining("阶段 2"),
      },
    });
  });

  it("note.read/create/save 合法入参 → NOT_IMPLEMENTED", async () => {
    const read = await call(IPC_CHANNELS.noteRead, {
      vaultId: "v1",
      relativePath: "a.md",
    });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.code).toBe("NOT_IMPLEMENTED");

    const create = await call(IPC_CHANNELS.noteCreate, {
      vaultId: "v1",
      directory: "",
      title: "t",
    });
    if (!create.ok) expect(create.error.code).toBe("NOT_IMPLEMENTED");

    const save = await call(IPC_CHANNELS.noteSave, {
      vaultId: "v1",
      relativePath: "a.md",
      markdown: "m",
      expectedVersionToken: "",
    });
    if (!save.ok) expect(save.error.code).toBe("NOT_IMPLEMENTED");
  });

  it("asset 三方法 → NOT_IMPLEMENTED", async () => {
    for (const [channel, payload] of [
      [IPC_CHANNELS.assetPick, undefined],
      [
        IPC_CHANNELS.assetImport,
        { vaultId: "v1", sourceAbsolutePath: "/x/a.png", fileName: "a.png" },
      ],
      [IPC_CHANNELS.assetResolveUrl, "asset-1"],
    ] as const) {
      const result = await call(channel, payload);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("NOT_IMPLEMENTED");
    }
  });
});

describe("schema 校验在分发前拦截", () => {
  beforeEach(() => {
    registerIpcHandlers({ ipc: bus });
  });

  it("入参形状非法 → INVALID_INPUT（不进入业务实现）", async () => {
    const result = await call(IPC_CHANNELS.noteRead, { vaultId: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
  });

  it("路径逃逸 → PATH_ESCAPE", async () => {
    const result = await call(IPC_CHANNELS.noteSave, {
      vaultId: "v1",
      relativePath: "../../etc/passwd",
      markdown: "m",
      expectedVersionToken: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PATH_ESCAPE");
  });

  it("vault.scan 空串 → INVALID_INPUT", async () => {
    const result = await call(IPC_CHANNELS.vaultScan, "  ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
  });
});
