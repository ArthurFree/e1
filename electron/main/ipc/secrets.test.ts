// @vitest-environment node
/**
 * R007 阶段 5（§5.1）：secret 组 IPC handler 测试。
 * mock safeStorage + 真实 tmp 文件：status/get/set/delete 往返、
 * 不可用降级（status=false + 会话内存）、schema 拦截链
 * （非法名/空值/超长值/携带负载）。
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { IPC_CHANNELS, type IpcResult } from "../../../shared/ipc/contracts.js";
import {
  DesktopSecretPersistence,
  type SafeStorageLike,
} from "../state/DesktopSecretPersistence.js";
import type { IpcMainLike } from "./handler.js";
import { registerSecretHandlers } from "./secrets.js";

type Handler = (
  event: unknown,
  payload: unknown,
) => Promise<IpcResult<unknown>>;

let handlers: Map<string, Handler>;
let file: string;

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

function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, "utf8"),
    decryptString: (encrypted) => {
      const text = encrypted.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("decrypt failed");
      return text.slice("enc:".length);
    },
  };
}

function register(available = true) {
  registerSecretHandlers(bus, {
    store: new DesktopSecretPersistence(file, fakeSafeStorage(available)),
  });
}

beforeEach(async () => {
  handlers = new Map();
  const dir = await mkdtemp(join(tmpdir(), "e1-secret-ipc-"));
  file = join(dir, "secrets.json");
});

describe("secret.status / get / set / delete", () => {
  it("safeStorage 可用：status=true，set→get 往返，delete 后 null", async () => {
    register(true);
    expect(await call(IPC_CHANNELS.secretStatus)).toEqual({
      ok: true,
      value: { available: true },
    });
    expect(
      await call(IPC_CHANNELS.secretSet, {
        name: "ai.apiKey",
        value: "sk-机密",
      }),
    ).toEqual({ ok: true, value: undefined });
    expect(await call(IPC_CHANNELS.secretGet, "ai.apiKey")).toEqual({
      ok: true,
      value: "sk-机密",
    });
    // 落盘无明文。
    expect(await readFile(file, "utf8")).not.toContain("sk-机密");
    expect(await call(IPC_CHANNELS.secretDelete, "ai.apiKey")).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await call(IPC_CHANNELS.secretGet, "ai.apiKey")).toEqual({
      ok: true,
      value: null,
    });
  });

  it("safeStorage 不可用：status=false，读写仍可用（会话内存语义）", async () => {
    register(false);
    expect(await call(IPC_CHANNELS.secretStatus)).toEqual({
      ok: true,
      value: { available: false },
    });
    await call(IPC_CHANNELS.secretSet, { name: "ai.apiKey", value: "sk-会话" });
    expect(await call(IPC_CHANNELS.secretGet, "ai.apiKey")).toEqual({
      ok: true,
      value: "sk-会话",
    });
    // 不落盘。
    await expect(readFile(file, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("get 缺失记录 → ok(null)", async () => {
    register(true);
    expect(await call(IPC_CHANNELS.secretGet, "ai.apiKey")).toEqual({
      ok: true,
      value: null,
    });
  });

  it("schema 拦截链：非法入参 → INVALID_INPUT", async () => {
    register(true);
    // status 不接纳入参。
    expect(await call(IPC_CHANNELS.secretStatus, {})).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    // secret 名：非 "<域>.<键>" 形态全部拒绝。
    for (const name of [
      123,
      "",
      "apiKey",
      "AI.apiKey",
      "ai..apiKey",
      "ai.api key",
      `ai.${"x".repeat(200)}`,
    ]) {
      expect(await call(IPC_CHANNELS.secretGet, name)).toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT" },
      });
    }
    // set：空值/非字符串/超长值拒绝（清空须走 delete）。
    for (const payload of [
      { name: "ai.apiKey" },
      { name: "ai.apiKey", value: "" },
      { name: "ai.apiKey", value: 42 },
      { name: "ai.apiKey", value: "x".repeat(16_385) },
      "ai.apiKey",
    ]) {
      expect(await call(IPC_CHANNELS.secretSet, payload)).toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT" },
      });
    }
  });
});
