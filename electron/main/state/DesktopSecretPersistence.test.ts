// @vitest-environment node
/**
 * R007 阶段 5（§5.1，G3）：DesktopSecretPersistence 测试。
 * mock safeStorage（确定性伪加密）+ 真实 tmp 文件系统：
 * 加密落盘往返、磁盘无明文、损坏自愈（备份 + 空表）、单条解密失败按缺失、
 * 安全存储不可用时会话内存降级（不落盘、重启丢失）。
 */
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DesktopSecretPersistence,
  type SafeStorageLike,
} from "./DesktopSecretPersistence.js";

/** 确定性伪加密：encrypt 加前缀，decrypt 校验前缀（否则抛错模拟解密失败）。 */
function fakeSafeStorage(
  options: { available?: boolean } = {},
): SafeStorageLike {
  const available = options.available ?? true;
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

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "e1-secrets-"));
  file = join(dir, "secrets.json");
});

describe("DesktopSecretPersistence（safeStorage 可用）", () => {
  it("set → get 往返；磁盘只有密文 base64，无明文", async () => {
    const store = new DesktopSecretPersistence(file, fakeSafeStorage());
    await store.set("ai.apiKey", "sk-超级机密");
    expect(await store.get("ai.apiKey")).toBe("sk-超级机密");

    const onDisk = await readFile(file, "utf8");
    expect(onDisk).not.toContain("sk-超级机密");
    const parsed = JSON.parse(onDisk) as {
      version: number;
      secrets: Record<string, string>;
    };
    expect(parsed.version).toBe(1);
    // base64("enc:sk-超级机密")——密文形态落盘。
    expect(parsed.secrets["ai.apiKey"]).toBe(
      Buffer.from("enc:sk-超级机密", "utf8").toString("base64"),
    );
  });

  it("覆盖写与 remove（缺失 no-op）", async () => {
    const store = new DesktopSecretPersistence(file, fakeSafeStorage());
    await store.set("ai.apiKey", "sk-1");
    await store.set("ai.apiKey", "sk-2");
    expect(await store.get("ai.apiKey")).toBe("sk-2");
    await store.remove("ai.apiKey");
    expect(await store.get("ai.apiKey")).toBeNull();
    // 对缺失记录 remove 为 no-op（不抛、不产生文件变化之外的行为）。
    await store.remove("ai.apiKey");
    expect(await store.get("ai.apiKey")).toBeNull();
  });

  it("文件缺失 → get 返回 null（空表）", async () => {
    const store = new DesktopSecretPersistence(file, fakeSafeStorage());
    expect(await store.get("ai.apiKey")).toBeNull();
  });

  it("JSON 损坏 → 备份 .corrupt-* 后自愈为空表", async () => {
    await writeFile(file, "{不是 JSON", "utf8");
    const store = new DesktopSecretPersistence(
      file,
      fakeSafeStorage(),
      () => 42,
    );
    expect(await store.get("ai.apiKey")).toBeNull();
    const entries = await readdir(dir);
    expect(entries).toContain("secrets.json.corrupt-42");
    // 自愈后可正常读写。
    await store.set("ai.apiKey", "sk-新");
    expect(await store.get("ai.apiKey")).toBe("sk-新");
  });

  it("顶层形状非法（version 不符）同样走损坏自愈", async () => {
    await writeFile(file, JSON.stringify({ version: 2, secrets: {} }), "utf8");
    const store = new DesktopSecretPersistence(file, fakeSafeStorage());
    expect(await store.get("ai.apiKey")).toBeNull();
    const entries = await readdir(dir);
    expect(entries.some((e) => e.startsWith("secrets.json.corrupt-"))).toBe(
      true,
    );
  });

  it("单条记录无法解密（他机复制/密钥链变更）按缺失处理，其余记录可读", async () => {
    const store = new DesktopSecretPersistence(file, fakeSafeStorage());
    await store.set("ai.apiKey", "sk-好");
    // 手工塞入一条本机密钥链解不开的记录（base64 合法但密文非法）。
    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      version: number;
      secrets: Record<string, string>;
    };
    parsed.secrets["ai.other"] = Buffer.from("他机密文", "utf8").toString(
      "base64",
    );
    await writeFile(file, JSON.stringify(parsed), "utf8");
    expect(await store.get("ai.other")).toBeNull();
    expect(await store.get("ai.apiKey")).toBe("sk-好");
  });

  it("跨实例读回（模拟重启）：密文持久化", async () => {
    const first = new DesktopSecretPersistence(file, fakeSafeStorage());
    await first.set("ai.apiKey", "sk-重启保持");
    const second = new DesktopSecretPersistence(file, fakeSafeStorage());
    expect(await second.get("ai.apiKey")).toBe("sk-重启保持");
  });
});

describe("DesktopSecretPersistence（safeStorage 不可用 → 会话内存降级）", () => {
  it("status 报不可用；读写走会话内存，不落盘（永不明文）", async () => {
    const store = new DesktopSecretPersistence(
      file,
      fakeSafeStorage({ available: false }),
    );
    expect(store.isAvailable()).toBe(false);
    await store.set("ai.apiKey", "sk-仅会话");
    expect(await store.get("ai.apiKey")).toBe("sk-仅会话");
    // 不落盘：文件不存在。
    await expect(readFile(file, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    // 会话内存：新实例（模拟重启）读不到。
    const restarted = new DesktopSecretPersistence(
      file,
      fakeSafeStorage({ available: false }),
    );
    expect(await restarted.get("ai.apiKey")).toBeNull();
  });

  it("不可用降级路径的 remove 为 no-op 不抛错", async () => {
    const store = new DesktopSecretPersistence(
      file,
      fakeSafeStorage({ available: false }),
    );
    await store.remove("ai.apiKey");
    expect(await store.get("ai.apiKey")).toBeNull();
  });
});
