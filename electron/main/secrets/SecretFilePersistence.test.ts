// @vitest-environment node
/**
 * R008 Stage 1（§8.4）：secrets.json 持久化测试（真实 tmp 文件系统）。
 * 覆盖：缺失文件空表、put/get/delete 往返、JSON 损坏备份自愈、
 * unknown version 备份且不覆盖原文件内容、逐条丢弃畸形条目。
 */
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SecretFilePersistence } from "./SecretFilePersistence.js";

let dir: string;
let filePath: string;
let persistence: SecretFilePersistence;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "e1-secrets-"));
  filePath = join(dir, "secrets.json");
  persistence = new SecretFilePersistence(filePath, () => 1000);
});

describe("SecretFilePersistence", () => {
  it("文件缺失 → getCiphertext 返回 null；delete 为 no-op", async () => {
    expect(await persistence.getCiphertext("ai.apiKey")).toBeNull();
    await persistence.delete("ai.apiKey");
    // no-op 不创建文件
    await expect(readFile(filePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("put → getCiphertext 往返；重复 put 覆盖；文件不含明文语义字段", async () => {
    await persistence.put("ai.apiKey", "Y2lwaGVydGV4dA==");
    expect(await persistence.getCiphertext("ai.apiKey")).toBe(
      "Y2lwaGVydGV4dA==",
    );
    await persistence.put("ai.apiKey", "bmV3LWNpcGhlcg==");
    expect(await persistence.getCiphertext("ai.apiKey")).toBe(
      "bmV3LWNpcGhlcg==",
    );

    const raw = JSON.parse(await readFile(filePath, "utf8")) as {
      version: number;
      entries: Record<string, { ciphertext: string; updatedAt: number }>;
    };
    expect(raw.version).toBe(1);
    expect(raw.entries["ai.apiKey"]).toEqual({
      ciphertext: "bmV3LWNpcGhlcg==",
      updatedAt: 1000,
    });
  });

  it("delete 删除条目并落盘；对不同 name 隔离", async () => {
    await persistence.put("a.key", "QQ==");
    await persistence.put("b.key", "Qg==");
    await persistence.delete("a.key");
    expect(await persistence.getCiphertext("a.key")).toBeNull();
    expect(await persistence.getCiphertext("b.key")).toBe("Qg==");
  });

  it("JSON 损坏 → 备份 .corrupt-<ts> 后按空表自愈，下次写入重建", async () => {
    await writeFile(filePath, "这不是 json{{{", "utf8");
    expect(await persistence.getCiphertext("ai.apiKey")).toBeNull();
    expect((await readdir(dir)).sort()).toEqual([
      "secrets.json",
      "secrets.json.corrupt-1000",
    ]);
    // 原文件字节保留在备份中
    expect(await readFile(`${filePath}.corrupt-1000`, "utf8")).toBe(
      "这不是 json{{{",
    );
    // 自愈后可正常写入
    await persistence.put("ai.apiKey", "QQ==");
    expect(await persistence.getCiphertext("ai.apiKey")).toBe("QQ==");
  });

  it("unknown schema version → 备份原文件、按空表处理，原内容不被静默丢弃", async () => {
    const future = JSON.stringify({
      version: 2,
      entries: { "ai.apiKey": { ciphertext: "QQ==", updatedAt: 1 } },
    });
    await writeFile(filePath, future, "utf8");
    // 不读未知版本的条目
    expect(await persistence.getCiphertext("ai.apiKey")).toBeNull();
    // 原文件备份保留（不直接覆盖丢弃）
    expect(await readFile(`${filePath}.corrupt-1000`, "utf8")).toBe(future);
  });

  it("逐条丢弃畸形条目（能救多少救多少）", async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        entries: {
          good: { ciphertext: "QQ==", updatedAt: 1 },
          "bad-shape": "not-an-object",
          "bad-ciphertext": { ciphertext: "", updatedAt: 1 },
          "bad-updatedAt": { ciphertext: "Qg==", updatedAt: -1 },
        },
      }),
      "utf8",
    );
    expect(await persistence.getCiphertext("good")).toBe("QQ==");
    expect(await persistence.getCiphertext("bad-shape")).toBeNull();
    expect(await persistence.getCiphertext("bad-ciphertext")).toBeNull();
    expect(await persistence.getCiphertext("bad-updatedAt")).toBeNull();
  });
});
