// @vitest-environment node
/**
 * R006 阶段 1：Main 侧 IPC handler 分发与错误归一测试。
 * ipcMain/原生对话框全部注入 mock（registerIpcHandlers 依赖注入），
 * 验证：channel 注册齐全、selectDirectory 真实行为（取消/选中）、
 * schema 校验失败归一 INVALID_INPUT/PATH_ESCAPE、契约桩归一 NOT_IMPLEMENTED。
 * R006 阶段 2：vault scan/listRecent 真实实现的行为测试见
 * ./vault.test.ts（真实 tmp 文件系统 + 真实注册表）；本文件保留
 * 注册齐全与 schema 拦截断言。
 * R006-C2.1：selectDirectory 返回一次性 selectionToken（不再返回
 * absolutePath）；openSelection/openRecent 行为测试同样在 vault.test.ts。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { IPC_CHANNELS, type IpcResult } from "../../../shared/ipc/contracts.js";
import { registerIpcHandlers } from "./index.js";
import type { IpcMainLike } from "./handler.js";
import type { OpenDialogLike } from "./vault.js";

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir() },
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  // R007 阶段 5：secret 组（safeStorage 加密持久化）与 reveal 组（shell）的
  // 缺省依赖；本文件不调用这两组 handler，占位防 vitest 未定义导出报错。
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(`enc:${plain}`, "utf8"),
    decryptString: (encrypted: Buffer) =>
      encrypted.toString("utf8").slice("enc:".length),
  },
  shell: { showItemInFolder: vi.fn() },
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
  it("全部 request/response channel 注册（vault 5 + note 4 + asset 4 + vaultState 2）", () => {
    registerIpcHandlers({ ipc: bus });
    // events:vaultChanges 是 Main→Renderer 单向推送通道（R007 阶段 3），
    // 不注册 ipcMain.handle，从断言集中排除。
    const requestChannels = Object.values(IPC_CHANNELS).filter(
      (channel) => channel !== IPC_CHANNELS.eventsVaultChanges,
    );
    expect([...handlers.keys()].sort()).toEqual(requestChannels.sort());
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

  it("选中目录返回令牌 + vaultId 为 null 的目录信息（basename 为展示名，不含绝对路径）", async () => {
    const showOpenDialog = vi
      .fn()
      .mockResolvedValue({ canceled: false, filePaths: ["/Users/x/我的笔记"] });
    registerIpcHandlers({ ipc: bus, openDialog: { showOpenDialog } });
    const result = await call(IPC_CHANNELS.vaultSelectDirectory);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const selected = result.value as Record<string, unknown>;
    expect(selected).toMatchObject({
      vaultId: null,
      displayName: "我的笔记",
      initialized: false,
    });
    expect(selected.selectionToken).toMatch(/^[0-9a-f-]{36}$/);
    // SEC-01：Renderer 拿不到绝对路径。
    expect(selected).not.toHaveProperty("absolutePath");
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

  it("note.create / note.save 已真实实现（未登记 → VAULT_NOT_FOUND）", async () => {
    const create = await call(IPC_CHANNELS.noteCreate, {
      vaultId: "v1",
      directory: "",
      title: "t",
    });
    expect(create.ok).toBe(false);
    if (!create.ok) expect(create.error.code).toBe("VAULT_NOT_FOUND");

    const save = await call(IPC_CHANNELS.noteSave, {
      vaultId: "v1",
      relativePath: "a.md",
      markdown: "m",
      expectedVersionToken: "",
    });
    expect(save.ok).toBe(false);
    if (!save.ok) expect(save.error.code).toBe("VAULT_NOT_FOUND");
  });
  it("note.read 已是真实实现（R006-C3-A）：未登记 vaultId → VAULT_NOT_FOUND", async () => {
    // 行为测试（正常读取/transient/拦截链）见 ./note.test.ts；
    // 此处只验证 registerIpcHandlers 接线后不再是 NOT_IMPLEMENTED 桩。
    const read = await call(IPC_CHANNELS.noteRead, {
      vaultId: "v-未登记",
      relativePath: "a.md",
    });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.code).toBe("VAULT_NOT_FOUND");
  });

  it("asset.import 未登记 vaultId → VAULT_NOT_FOUND（不再是桩）", async () => {
    const result = await call(IPC_CHANNELS.assetImport, {
      vaultId: "v-未登记",
      fileName: "a.png",
      mimeType: "image/png",
      source: { kind: "pick-token", token: "p-token" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VAULT_NOT_FOUND");
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
