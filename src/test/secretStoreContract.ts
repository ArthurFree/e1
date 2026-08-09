/**
 * SecretStore port 契约套件（R005 阶段 8 §8.2）：Web IndexedDB 实现
 * 与内存实现共用同一组行为断言，保证两实现语义一致（参照
 * recoveryStoreContract / assetStoreContract 模式）。
 *
 * 覆盖：
 * - 缺失记录 get 返回 null；
 * - set → get 往返与覆盖写；
 * - remove 删除、对缺失记录为 no-op；
 * - 不同 name 相互隔离。
 */
import { describe, expect, it } from "vitest";
import type { SecretStore } from "../application/services/SecretStore";

export function describeSecretStoreContract(
  name: string,
  makeStore: () => SecretStore | Promise<SecretStore>,
): void {
  describe(`SecretStore 契约（${name}）`, () => {
    it("缺失记录 get 返回 null", async () => {
      const store = await makeStore();
      expect(await store.get("ai.apiKey")).toBeNull();
    });

    it("set → get 往返；重复 set 覆盖", async () => {
      const store = await makeStore();
      await store.set("ai.apiKey", "sk-1");
      expect(await store.get("ai.apiKey")).toBe("sk-1");
      await store.set("ai.apiKey", "sk-2");
      expect(await store.get("ai.apiKey")).toBe("sk-2");
    });

    it("remove 删除；对缺失记录为 no-op", async () => {
      const store = await makeStore();
      await store.set("ai.apiKey", "sk-1");
      await store.remove("ai.apiKey");
      expect(await store.get("ai.apiKey")).toBeNull();
      await store.remove("ai.apiKey");
      expect(await store.get("ai.apiKey")).toBeNull();
    });

    it("不同 name 相互隔离", async () => {
      const store = await makeStore();
      await store.set("a.key", "va");
      await store.set("b.key", "vb");
      expect(await store.get("a.key")).toBe("va");
      expect(await store.get("b.key")).toBe("vb");
      await store.remove("a.key");
      expect(await store.get("a.key")).toBeNull();
      expect(await store.get("b.key")).toBe("vb");
    });
  });
}
