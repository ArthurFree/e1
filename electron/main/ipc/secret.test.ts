// @vitest-environment node
/**
 * R008 Stage 1（§8.3/§15.1）：secret 组 IPC handler 测试。
 * 真实 DesktopSecretStore + mock safeStorage + tmp 持久化：
 * set/get/remove 往返、getStatus、schema 拦截链（name 白名单 /
 * value 长度上限 / 非对象入参）、错误不携带 secret 值。
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  IPC_CHANNELS,
  type IpcResult,
  type SecretStorageStatus,
} from "../../../shared/ipc/contracts.js";
import { SECRET_VALUE_MAX_LENGTH } from "../../../shared/ipc/schemas.js";
import { DesktopSecretStore } from "../secrets/DesktopSecretStore.js";
import { SecretFilePersistence } from "../secrets/SecretFilePersistence.js";
import type { SafeStorageLike } from "../secrets/SecretBackendStatus.js";
import type { IpcMainLike } from "./handler.js";
import { registerSecretHandlers } from "./secret.js";

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

function safeStorageMock(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptStringAsync: async (v: string) => Buffer.from(`enc:${v}`, "utf8"),
    decryptStringAsync: async (b: Buffer) => {
      const s = b.toString("utf8");
      if (!s.startsWith("enc:")) throw new Error("解密失败");
      return { shouldReEncrypt: false, result: s.slice(4) };
    },
  };
}

beforeEach(async () => {
  handlers = new Map();
  const dir = await mkdtemp(join(tmpdir(), "e1-secret-ipc-"));
  registerSecretHandlers(bus, {
    store: new DesktopSecretStore(
      new SecretFilePersistence(join(dir, "secrets.json")),
      safeStorageMock(),
    ),
  });
});

describe("secret.get / set / remove", () => {
  it("set → get 往返；get 缺失返回 null；remove 后读不到", async () => {
    const missing = await call(IPC_CHANNELS.secretGet, { name: "ai.apiKey" });
    expect(missing).toEqual({ ok: true, value: null });

    const set = await call(IPC_CHANNELS.secretSet, {
      name: "ai.apiKey",
      value: "sk-ipc-001",
    });
    expect(set).toEqual({ ok: true, value: null });

    const got = await call(IPC_CHANNELS.secretGet, { name: "ai.apiKey" });
    expect(got).toEqual({ ok: true, value: "sk-ipc-001" });

    const removed = await call(IPC_CHANNELS.secretRemove, {
      name: "ai.apiKey",
    });
    expect(removed).toEqual({ ok: true, value: null });
    const after = await call(IPC_CHANNELS.secretGet, { name: "ai.apiKey" });
    expect(after).toEqual({ ok: true, value: null });
  });

  it("getStatus 返回 secure-persistent（mock 安全 backend）", async () => {
    const res = (await call(
      IPC_CHANNELS.secretGetStatus,
    )) as IpcResult<SecretStorageStatus>;
    expect(res).toEqual({ ok: true, value: { mode: "secure-persistent" } });
  });

  it("getStatus 拒绝携带入参", async () => {
    const res = await call(IPC_CHANNELS.secretGetStatus, { name: "x" });
    expect(res).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });
});

describe("secret schema 拦截链", () => {
  it("非法入参形状 → INVALID_INPUT", async () => {
    for (const payload of [undefined, 42, "ai.apiKey", [], null]) {
      const res = await call(IPC_CHANNELS.secretGet, payload);
      expect(res).toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT" },
      });
    }
  });

  it("name 白名单：空串/空格/路径分隔符/中文/超长 → INVALID_INPUT", async () => {
    for (const name of [
      "",
      "   ",
      "a/b",
      "a\\b",
      "密钥",
      ".hidden",
      `a${"b".repeat(128)}`,
    ]) {
      const res = await call(IPC_CHANNELS.secretGet, { name });
      expect(res, `name=${name}`).toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT" },
      });
    }
    // 合法：字母数字 + . _ -
    const ok = await call(IPC_CHANNELS.secretGet, { name: "ai.api_key-1" });
    expect(ok).toEqual({ ok: true, value: null });
  });

  it("value 类型/长度校验：非字符串或超 8KiB → INVALID_INPUT", async () => {
    const nonString = await call(IPC_CHANNELS.secretSet, {
      name: "ai.apiKey",
      value: 123,
    });
    expect(nonString).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    const tooLong = await call(IPC_CHANNELS.secretSet, {
      name: "ai.apiKey",
      value: "x".repeat(SECRET_VALUE_MAX_LENGTH + 1),
    });
    expect(tooLong).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    const atLimit = await call(IPC_CHANNELS.secretSet, {
      name: "ai.apiKey",
      value: "x".repeat(SECRET_VALUE_MAX_LENGTH),
    });
    expect(atLimit).toEqual({ ok: true, value: null });
  });
});
