/**
 * SecretStore 的 IndexedDB 实现（R005 阶段 8 §8.2）：
 * 跑共享契约套件，另覆盖损坏记录降级（value 非字符串按缺失处理）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getDB, resetDB, STORE_SECRETS } from "./db";
import { secretStore } from "./secretStore";
import { describeSecretStoreContract } from "../../../test/secretStoreContract";

beforeEach(async () => {
  await resetDB();
});

describeSecretStoreContract("IndexedDB", () => secretStore);

describe("IndexedDB SecretStore 实现细节", () => {
  it("损坏记录（value 非字符串）get 返回 null", async () => {
    const db = await getDB();
    await db.put(STORE_SECRETS, { name: "ai.apiKey", value: 123 });
    expect(await secretStore.get("ai.apiKey")).toBeNull();
  });
});
