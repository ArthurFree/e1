/**
 * RecoveryStore port 契约套件（R005 阶段 8 §8.1）：Web localStorage 实现
 * 与内存实现共用同一组行为断言，保证两实现语义一致（参照
 * assetStoreContract 模式）。
 *
 * 覆盖：
 * - write → read 往返；缺失记录 read 返回 null；
 * - clear 代次语义：仅删除代次已落盘（≤ savedGeneration）的缓冲；
 * - discard 无条件删除；
 * - 损坏记录（正文 JSON 未通过白名单校验）read 时删除并返回 null，
 *   合法内容不受影响（「绝不让坏数据进入编辑器」）。
 */
import { describe, expect, it } from "vitest";
import type {
  RecoveryRecord,
  RecoveryStore,
} from "../application/services/RecoveryStore";

const VALID_DOC = { type: "doc", content: [{ type: "paragraph" }] };
const CORRUPTED_DOC = { type: "doc", content: [{ type: "evilNode" }] };

function record(pageId: string, generation: number): RecoveryRecord {
  return { pageId, contentJson: VALID_DOC, generation, timestamp: 1000 };
}

export function describeRecoveryStoreContract(
  name: string,
  makeStore: () => RecoveryStore | Promise<RecoveryStore>,
): void {
  describe(`RecoveryStore 契约（${name}）`, () => {
    it("write → read 往返；缺失记录返回 null", async () => {
      const store = await makeStore();
      expect(await store.read("p1")).toBeNull();
      await store.write(record("p1", 1));
      expect(await store.read("p1")).toEqual(record("p1", 1));
      // 其他文档不受影响。
      expect(await store.read("p2")).toBeNull();
    });

    it("clear 仅删除代次已落盘的缓冲（≤ savedGeneration）", async () => {
      const store = await makeStore();
      await store.write(record("p1", 3));
      // 缓冲代次更新（3 > 2）：旧保存不得清掉未落盘内容。
      await store.clear("p1", 2);
      expect(await store.read("p1")).not.toBeNull();
      // 代次已落盘（3 ≤ 3）：删除。
      await store.clear("p1", 3);
      expect(await store.read("p1")).toBeNull();
    });

    it("discard 无条件删除", async () => {
      const store = await makeStore();
      await store.write(record("p1", 5));
      await store.discard("p1");
      expect(await store.read("p1")).toBeNull();
      // 对缺失记录为 no-op。
      await store.discard("p1");
      expect(await store.read("p1")).toBeNull();
    });

    it("损坏记录 read 时删除并返回 null，合法内容不受影响", async () => {
      const store = await makeStore();
      await store.write({
        pageId: "p1",
        contentJson: CORRUPTED_DOC,
        generation: 3,
        timestamp: 1000,
      });
      expect(await store.read("p1")).toBeNull();
      await store.write(record("p2", 1));
      expect(await store.read("p2")).not.toBeNull();
    });
  });
}
