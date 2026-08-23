// @vitest-environment node
/**
 * R008 Stage 1（§8.4/§8.5，G2）：SecretFilePersistence 测试。
 * mock safeStorage（确定性伪加密，含 async 变体）+ 真实 tmp 文件系统：
 * 加密落盘往返（entries 格式 + updatedAt）、async 接口优先与
 * shouldReEncrypt 重写、磁盘无明文、损坏/未知版本自愈（原内容留备份）、
 * 单条解密失败按缺失、R007 旧格式迁移、非 secure-persistent 会话内存降级。
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretStorageMode } from "../../../shared/ipc/contracts.js";
import {
  SecretFilePersistence,
  type SafeStorageLike,
} from "./SecretFilePersistence.js";

/** 确定性伪加密：encrypt 加前缀，decrypt 校验前缀（否则抛错模拟解密失败）。 */
function fakeSafeStorage(options: { async?: boolean } = {}): SafeStorageLike {
  const base: SafeStorageLike = {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, "utf8"),
    decryptString: (encrypted) => {
      const text = encrypted.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("decrypt failed");
      return text.slice("enc:".length);
    },
  };
  if (options.async) {
    base.encryptStringAsync = async (plain) =>
      Buffer.from(`enc:${plain}`, "utf8");
    base.decryptStringAsync = async (encrypted) => {
      const text = encrypted.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("decrypt failed");
      return { shouldReEncrypt: false, result: text.slice("enc:".length) };
    };
  }
  return base;
}

function makeStore(
  file: string,
  mode: SecretStorageMode = "secure-persistent",
  safeStorage: SafeStorageLike = fakeSafeStorage(),
  now: () => number = () => Date.now(),
) {
  return new SecretFilePersistence(file, safeStorage, () => mode, now);
}

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "e1-secrets-"));
  file = join(dir, "secrets.json");
});

describe("SecretFilePersistence（secure-persistent）", () => {
  it("set → get 往返；磁盘为 entries 格式密文 base64，无明文", async () => {
    const store = makeStore(
      file,
      "secure-persistent",
      fakeSafeStorage(),
      () => 777,
    );
    await store.set("ai.apiKey", "sk-超级机密");
    expect(await store.get("ai.apiKey")).toBe("sk-超级机密");

    const onDisk = await readFile(file, "utf8");
    expect(onDisk).not.toContain("sk-超级机密");
    const parsed = JSON.parse(onDisk) as {
      version: number;
      entries: Record<string, { ciphertext: string; updatedAt: number }>;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.entries["ai.apiKey"]).toEqual({
      ciphertext: Buffer.from("enc:sk-超级机密", "utf8").toString("base64"),
      updatedAt: 777,
    });
  });

  it("覆盖写与 remove（缺失 no-op）；跨实例读回（模拟重启）", async () => {
    const store = makeStore(file);
    await store.set("ai.apiKey", "sk-1");
    await store.set("ai.apiKey", "sk-2");
    expect(await store.get("ai.apiKey")).toBe("sk-2");
    await store.remove("ai.apiKey");
    expect(await store.get("ai.apiKey")).toBeNull();
    await store.remove("ai.apiKey");

    await makeStore(file).set("ai.apiKey", "sk-重启保持");
    expect(await makeStore(file).get("ai.apiKey")).toBe("sk-重启保持");
  });

  it("优先 async 加解密接口（§8.5）", async () => {
    const safeStorage = fakeSafeStorage({ async: true });
    const encryptSpy = vi.spyOn(safeStorage, "encryptStringAsync");
    const store = makeStore(file, "secure-persistent", safeStorage);
    await store.set("ai.apiKey", "sk-异步");
    expect(encryptSpy).toHaveBeenCalled();
    expect(await store.get("ai.apiKey")).toBe("sk-异步");
  });

  it("decryptStringAsync 报告 shouldReEncrypt 时重写该条（密钥轮换）", async () => {
    const safeStorage = fakeSafeStorage({ async: true });
    safeStorage.decryptStringAsync = async (encrypted) => ({
      shouldReEncrypt: true,
      result: encrypted.toString("utf8").slice("enc:".length),
    });
    let nowValue = 100;
    const store = new SecretFilePersistence(
      file,
      safeStorage,
      () => "secure-persistent",
      () => nowValue,
    );
    await store.set("ai.apiKey", "sk-轮换");
    const before = JSON.parse(await readFile(file, "utf8")) as {
      entries: Record<string, { updatedAt: number }>;
    };
    expect(before.entries["ai.apiKey"].updatedAt).toBe(100);
    nowValue = 999;
    expect(await store.get("ai.apiKey")).toBe("sk-轮换");
    const after = JSON.parse(await readFile(file, "utf8")) as {
      entries: Record<string, { updatedAt: number }>;
    };
    expect(after.entries["ai.apiKey"].updatedAt).toBe(999);
  });

  it("JSON 损坏 / 未知 schema version → 备份自愈，原内容保留在备份中", async () => {
    for (const content of [
      "{不是 JSON",
      JSON.stringify({ version: 2, entries: {} }),
    ]) {
      await writeFile(file, content, "utf8");
      const store = makeStore(
        file,
        "secure-persistent",
        fakeSafeStorage(),
        () => 42,
      );
      expect(await store.get("ai.apiKey")).toBeNull();
      // 自愈后可正常读写。
      await store.set("ai.apiKey", "sk-新");
      expect(await store.get("ai.apiKey")).toBe("sk-新");
      // 原内容不被湮灭：备份文件保留原始字节。
      const backup = await readFile(
        join(dir, "secrets.json.corrupt-42"),
        "utf8",
      );
      expect(backup).toBe(content);
      // 清理以便下一轮用例（每轮重新写坏文件）。
      await store.remove("ai.apiKey");
    }
  });

  it("单条记录无法解密（他机复制/密钥链变更）按缺失处理，其余记录可读", async () => {
    const store = makeStore(file);
    await store.set("ai.apiKey", "sk-好");
    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      version: number;
      entries: Record<string, { ciphertext: string; updatedAt: number }>;
    };
    parsed.entries["ai.other"] = {
      ciphertext: Buffer.from("他机密文", "utf8").toString("base64"),
      updatedAt: 1,
    };
    await writeFile(file, JSON.stringify(parsed), "utf8");
    expect(await store.get("ai.other")).toBeNull();
    expect(await store.get("ai.apiKey")).toBe("sk-好");
  });

  it("R007 阶段 5 旧格式（secrets: name→base64）读迁移", async () => {
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        secrets: {
          "ai.apiKey": Buffer.from("enc:sk-旧格式", "utf8").toString("base64"),
        },
      }),
      "utf8",
    );
    const store = makeStore(file);
    expect(await store.get("ai.apiKey")).toBe("sk-旧格式");
    // 下次写盘即新格式（entries）。
    await store.set("ai.apiKey", "sk-旧格式");
    const parsed = JSON.parse(await readFile(file, "utf8")) as Record<
      string,
      unknown
    >;
    expect(parsed.entries).toBeDefined();
    expect(parsed.secrets).toBeUndefined();
  });
});

describe("SecretFilePersistence（session-only / unavailable → 会话内存降级）", () => {
  it("session-only：读写走会话内存，不落盘（绝不弱保护落盘）", async () => {
    const store = makeStore(file, "session-only");
    await store.set("ai.apiKey", "sk-仅会话");
    expect(await store.get("ai.apiKey")).toBe("sk-仅会话");
    await expect(readFile(file, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    // 会话内存：新实例（模拟重启）读不到。
    expect(await makeStore(file, "session-only").get("ai.apiKey")).toBeNull();
  });

  it("unavailable：同样会话内存；remove 为 no-op 不抛错", async () => {
    const store = makeStore(file, "unavailable");
    await store.set("ai.apiKey", "sk-x");
    await store.remove("ai.apiKey");
    expect(await store.get("ai.apiKey")).toBeNull();
    await expect(readFile(file, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
