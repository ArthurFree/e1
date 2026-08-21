// @vitest-environment node
/**
 * R008 Stage 1（§8.4/§8.5/§8.8）：Main DesktopSecretStore 编排测试。
 * mock safeStorage + 真实 tmp 文件持久化，覆盖：
 * - secure-persistent：加密往返、异步/同步 API 口径、落盘无明文、
 *   跨实例（模拟重启）保持、remove 删除与缺失 no-op；
 * - 密文损坏（解密失败）→ get 返回 null（与 port「记录损坏」语义一致）；
 * - session-only（不安全 backend）：内存读写、绝不落盘、重启丢失；
 * - unavailable：set 抛 SECRET_STORAGE_UNAVAILABLE、get null、remove no-op。
 */
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IpcFailure } from "../../../shared/errors.js";
import { DesktopSecretStore } from "./DesktopSecretStore.js";
import type { SafeStorageLike } from "./SecretBackendStatus.js";
import { SecretFilePersistence } from "./SecretFilePersistence.js";

/** 可逆「加密」mock：密文含 enc: 前缀，便于断言落盘内容与明文不同。 */
function asyncSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptStringAsync: vi.fn(async (v: string) =>
      Buffer.from(`enc:${v}`, "utf8"),
    ),
    decryptStringAsync: vi.fn(async (b: Buffer) => {
      const s = b.toString("utf8");
      if (!s.startsWith("enc:")) throw new Error("解密失败");
      return { shouldReEncrypt: false, result: s.slice(4) };
    }),
  };
}

function syncSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (v: string) => Buffer.from(`enc:${v}`, "utf8"),
    decryptString: (b: Buffer) => {
      const s = b.toString("utf8");
      if (!s.startsWith("enc:")) throw new Error("解密失败");
      return s.slice(4);
    },
  };
}

let dir: string;
let filePath: string;

function makeStore(
  safeStorage: SafeStorageLike | undefined,
  options: { forceBackend?: string } = {},
): DesktopSecretStore {
  return new DesktopSecretStore(
    new SecretFilePersistence(filePath),
    safeStorage,
    options,
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "e1-secret-store-"));
  filePath = join(dir, "secrets.json");
});

describe("DesktopSecretStore（secure-persistent）", () => {
  it("set → get 加密往返（异步 API 优先）；落盘为密文不含明文", async () => {
    const safe = asyncSafeStorage();
    const store = makeStore(safe);
    expect(store.getStatus().mode).toBe("secure-persistent");

    await store.set("ai.apiKey", "sk-secret-001");
    expect(await store.get("ai.apiKey")).toBe("sk-secret-001");
    expect(safe.encryptStringAsync).toHaveBeenCalledWith("sk-secret-001");

    const raw = await readFile(filePath, "utf8");
    expect(raw).not.toContain("sk-secret-001");
    const parsed = JSON.parse(raw) as {
      entries: Record<string, { ciphertext: string }>;
    };
    // base64("enc:sk-secret-001")
    expect(parsed.entries["ai.apiKey"]?.ciphertext).toBe(
      Buffer.from("enc:sk-secret-001", "utf8").toString("base64"),
    );
  });

  it("跨实例读取保持（模拟重启后 key 仍在）", async () => {
    await makeStore(asyncSafeStorage()).set("ai.apiKey", "sk-persist");
    const reopened = makeStore(asyncSafeStorage());
    expect(await reopened.get("ai.apiKey")).toBe("sk-persist");
  });

  it("异步 API 缺失时退回同步 encryptString/decryptString", async () => {
    const store = makeStore(syncSafeStorage());
    await store.set("ai.apiKey", "sk-sync");
    expect(await makeStore(syncSafeStorage()).get("ai.apiKey")).toBe("sk-sync");
  });

  it("remove 删除条目；对缺失记录为 no-op", async () => {
    const store = makeStore(asyncSafeStorage());
    await store.set("ai.apiKey", "sk-1");
    await store.remove("ai.apiKey");
    expect(await store.get("ai.apiKey")).toBeNull();
    await store.remove("ai.apiKey");
    expect(await store.get("ai.apiKey")).toBeNull();
  });

  it("密文损坏（解密失败）→ get 返回 null 而非抛错", async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        entries: {
          // base64("garbage")——缺少 enc: 前缀，mock 解密抛错
          "ai.apiKey": { ciphertext: "Z2FyYmFnZQ==", updatedAt: 1 },
        },
      }),
      "utf8",
    );
    expect(await makeStore(asyncSafeStorage()).get("ai.apiKey")).toBeNull();
  });
});

describe("DesktopSecretStore（session-only，不安全 backend）", () => {
  it("basic_text：内存读写可用，绝不落盘", async () => {
    const store = makeStore(asyncSafeStorage(), {
      forceBackend: "basic_text",
    });
    expect(store.getStatus()).toEqual({
      mode: "session-only",
      reason: "insecure-backend",
      backend: "basic_text",
    });
    await store.set("ai.apiKey", "sk-session");
    expect(await store.get("ai.apiKey")).toBe("sk-session");
    await store.remove("ai.apiKey");
    expect(await store.get("ai.apiKey")).toBeNull();
    // 全程不创建 secrets.json（不落明文/弱保护）
    await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("isEncryptionAvailable false：同 session-only 语义", async () => {
    const safe: SafeStorageLike = {
      ...asyncSafeStorage(),
      isEncryptionAvailable: () => false,
    };
    const store = makeStore(safe);
    expect(store.getStatus().mode).toBe("session-only");
    await store.set("ai.apiKey", "sk-session");
    await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("session-only 不读既有文件；新实例（重启）后 key 丢失", async () => {
    // 预置一个密文文件（模拟此前 secure 模式写入）——session-only 不读它
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        entries: {
          "ai.apiKey": {
            ciphertext: Buffer.from("enc:sk-old", "utf8").toString("base64"),
            updatedAt: 1,
          },
        },
      }),
      "utf8",
    );
    const store = makeStore(asyncSafeStorage(), { forceBackend: "basic_text" });
    expect(await store.get("ai.apiKey")).toBeNull();

    await store.set("ai.apiKey", "sk-session");
    // 「重启」：新实例同一持久化文件，session Map 丢失
    const reopened = makeStore(asyncSafeStorage(), {
      forceBackend: "basic_text",
    });
    expect(await reopened.get("ai.apiKey")).toBeNull();
  });
});

describe("DesktopSecretStore（unavailable）", () => {
  it("set 抛 SECRET_STORAGE_UNAVAILABLE；get 返回 null；remove 为 no-op", async () => {
    const store = makeStore(undefined);
    expect(store.getStatus()).toEqual({
      mode: "unavailable",
      reason: "safe-storage-missing",
    });
    const failure = await store.set("ai.apiKey", "sk-x").catch((e) => e);
    expect(failure).toBeInstanceOf(IpcFailure);
    expect((failure as IpcFailure).code).toBe("SECRET_STORAGE_UNAVAILABLE");
    // 错误消息不携带 secret 值（§15.2）
    expect((failure as IpcFailure).message).not.toContain("sk-x");
    expect(await store.get("ai.apiKey")).toBeNull();
    await store.remove("ai.apiKey");
    await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
