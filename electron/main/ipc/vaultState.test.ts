// @vitest-environment node
/**
 * R007 阶段 2：vaultState 组 IPC handler 测试。
 * 真实 tmp 文件系统 + 真实 VaultRegistry/DesktopVaultStateStore：
 * get/patch 往返、未登记 vaultId → VAULT_NOT_FOUND、transient 会话
 * 短路（空表 + 不落盘）、schema 拦截链（非法 patch 形状）。
 */
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  IPC_CHANNELS,
  createEmptyVaultState,
  type IpcResult,
  type VaultState,
} from "../../../shared/ipc/contracts.js";
import { TransientVaultStore } from "../transientVaults.js";
import { VaultRegistry } from "../vaultRegistry.js";
import { DesktopVaultStateStore } from "../state/DesktopVaultStateStore.js";
import type { IpcMainLike } from "./handler.js";
import { registerVaultStateHandlers } from "./vaultState.js";

type Handler = (
  event: unknown,
  payload: unknown,
) => Promise<IpcResult<unknown>>;

let handlers: Map<string, Handler>;
let registry: VaultRegistry;
let transients: TransientVaultStore;
let stateDir: string;

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

beforeEach(async () => {
  handlers = new Map();
  const root = await mkdtemp(join(tmpdir(), "e1-vaultstate-ipc-"));
  registry = new VaultRegistry(join(root, "recent-vaults.json"));
  stateDir = join(root, "vault-state");
  transients = new TransientVaultStore();
  registerVaultStateHandlers(bus, {
    store: new DesktopVaultStateStore(stateDir),
    registry,
    transients,
  });
  await registry.touch({
    vaultId: "v1",
    absolutePath: "/x/笔记",
    displayName: "笔记",
  });
});

describe("vaultState.get / patch", () => {
  it("未登记 vaultId → VAULT_NOT_FOUND", async () => {
    const res = await call(IPC_CHANNELS.vaultStateGet, "unknown");
    expect(res).toMatchObject({ ok: false, error: { code: "VAULT_NOT_FOUND" } });
  });

  it("登记库：patch 后 get 读回（落盘往返）", async () => {
    const patched = (await call(IPC_CHANNELS.vaultStatePatch, {
      vaultId: "v1",
      patch: {
        pages: { "01JABC": { favoriteAt: 111, lastOpenedAt: 222 } },
        workspace: { favoriteAt: 333 },
      },
    })) as IpcResult<VaultState>;
    expect(patched.ok).toBe(true);
    const got = await call(IPC_CHANNELS.vaultStateGet, "v1");
    expect(got).toEqual({
      ok: true,
      value: {
        version: 1,
        pages: { "01JABC": { favoriteAt: 111, lastOpenedAt: 222 } },
        workspace: { favoriteAt: 333 },
      },
    });
    // 确落 userData/vault-state/<vaultId>.json。
    expect(await readdir(stateDir)).toEqual(["v1.json"]);
  });

  it("transient 会话：空表 + 不落盘", async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), "e1-vs-transient-"));
    const transientId = transients.add(vaultRoot, "预览");
    const patched = await call(IPC_CHANNELS.vaultStatePatch, {
      vaultId: transientId,
      patch: { workspace: { favoriteAt: 1 } },
    });
    expect(patched).toEqual({ ok: true, value: createEmptyVaultState() });
    const got = await call(IPC_CHANNELS.vaultStateGet, transientId);
    expect(got).toEqual({ ok: true, value: createEmptyVaultState() });
    await expect(readdir(stateDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("schema 拦截链：非法入参 → INVALID_INPUT", async () => {
    for (const payload of [
      undefined,
      42,
      { vaultId: "v1" },
      { vaultId: "v1", patch: {} },
      { vaultId: "v1", patch: { pages: { p: { favoriteAt: "x" } } } },
      { vaultId: "v1", patch: { pages: { p: { lastOpenedAt: -1 } } } },
      { vaultId: "v1", patch: { workspace: { favoriteAt: 1.5 } } },
    ]) {
      const res = await call(IPC_CHANNELS.vaultStatePatch, payload);
      expect(res).toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT" },
      });
    }
    const badGet = await call(IPC_CHANNELS.vaultStateGet, 123);
    expect(badGet).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  });
});
