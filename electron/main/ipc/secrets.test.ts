// @vitest-environment node
/**
 * R008 Stage 1（§8.3/§8.6）：secret 组 IPC handler 测试。
 * mock safeStorage + 真实 tmp 文件：status 三模式、get/set/delete 往返、
 * 非 secure-persistent 会话内存语义、schema 拦截链。
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  IPC_CHANNELS,
  type IpcResult,
  type SecretStorageMode,
} from "../../../shared/ipc/contracts.js";
import {
  SecretFilePersistence,
  type SafeStorageLike,
} from "../secrets/SecretFilePersistence.js";
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

function fakeSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, "utf8"),
    decryptString: (encrypted) => {
      const text = encrypted.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("decrypt failed");
      return text.slice("enc:".length);
    },
  };
}

function register(mode: SecretStorageMode, backend?: string) {
  registerSecretHandlers(bus, {
    store: new SecretFilePersistence(file, fakeSafeStorage(), () => mode),
    status: () => ({ mode, ...(backend ? { backend } : {}) }),
  });
}

beforeEach(async () => {
  handlers = new Map();
  const dir = await mkdtemp(join(tmpdir(), "e1-secret-ipc-"));
  file = join(dir, "secrets.json");
});

describe("secret.status / get / set / delete", () => {
  it("secure-persistent：status 携带后端，set→get 往返，delete 后 null", async () => {
    register("secure-persistent", "keychain");
    expect(await call(IPC_CHANNELS.secretStatus)).toEqual({
      ok: true,
      value: { mode: "secure-persistent", backend: "keychain" },
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

  it("session-only / unavailable：status 如实上报，读写仍可用（会话内存，不落盘）", async () => {
    for (const mode of ["session-only", "unavailable"] as const) {
      handlers = new Map();
      register(mode, mode === "session-only" ? "basic_text" : undefined);
      expect(await call(IPC_CHANNELS.secretStatus)).toMatchObject({
        ok: true,
        value: { mode },
      });
      await call(IPC_CHANNELS.secretSet, {
        name: "ai.apiKey",
        value: "sk-会话",
      });
      expect(await call(IPC_CHANNELS.secretGet, "ai.apiKey")).toEqual({
        ok: true,
        value: "sk-会话",
      });
      await expect(readFile(file, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("get 缺失记录 → ok(null)", async () => {
    register("secure-persistent");
    expect(await call(IPC_CHANNELS.secretGet, "ai.apiKey")).toEqual({
      ok: true,
      value: null,
    });
  });

  it("schema 拦截链：非法入参 → INVALID_INPUT", async () => {
    register("secure-persistent");
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
