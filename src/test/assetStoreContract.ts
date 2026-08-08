/**
 * AssetStore port 契约套件（R005 阶段 5）：IndexedDB 与内存实现共用同一组
 * 行为断言，保证两实现语义一致（参照 contentSaveContract 模式）。
 *
 * 覆盖：
 * - add 返回纯元数据（不含字节字段），getMetadata/listByDocument 元数据往返；
 * - getBinary 字节级往返（Uint8Array 原样取回）；
 * - 缺失记录 getMetadata/getBinary 均返回 undefined；
 * - remove 删除；removeOrphans 语义与 createdBeforeOrAt 时间边界（R004 INV-03）。
 */
import { describe, expect, it } from "vitest";
import type { AssetStore } from "../domain/repositories";

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

export function describeAssetStoreContract(
  name: string,
  makeStore: () => AssetStore | Promise<AssetStore>,
): void {
  describe(`AssetStore 契约（${name}）`, () => {
    it("add 返回纯元数据；getMetadata/listByDocument 元数据往返", async () => {
      const store = await makeStore();
      const record = await store.add({
        pageId: "page-1",
        name: "说明.txt",
        mimeType: "text/plain",
        size: 3,
        data: bytes(1, 2, 3),
      });
      // 元数据上不暴露字节字段（Blob/Uint8Array 都不随元数据返回）。
      expect(record).toEqual({
        id: record.id,
        pageId: "page-1",
        name: "说明.txt",
        mimeType: "text/plain",
        size: 3,
        createdAt: expect.any(Number),
      });
      expect(await store.getMetadata(record.id)).toEqual(record);
      const list = await store.listByDocument("page-1");
      expect(list).toEqual([record]);
      // 其他文档不受影响。
      expect(await store.listByDocument("page-2")).toEqual([]);
    });

    it("getBinary 字节级往返", async () => {
      const store = await makeStore();
      const record = await store.add({
        pageId: "page-1",
        name: "图.png",
        mimeType: "image/png",
        size: 4,
        data: bytes(0x89, 0x50, 0x4e, 0x47),
      });
      const binary = await store.getBinary(record.id);
      expect(binary?.attachment).toEqual(record);
      expect([...(binary?.data ?? [])]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    });

    it("缺失记录：getMetadata/getBinary 均返回 undefined", async () => {
      const store = await makeStore();
      expect(await store.getMetadata("missing")).toBeUndefined();
      expect(await store.getBinary("missing")).toBeUndefined();
    });

    it("remove 删除后读取不到", async () => {
      const store = await makeStore();
      const record = await store.add({
        pageId: "page-1",
        name: "a.txt",
        mimeType: "text/plain",
        size: 1,
        data: bytes(1),
      });
      await store.remove(record.id);
      expect(await store.getMetadata(record.id)).toBeUndefined();
      expect(await store.getBinary(record.id)).toBeUndefined();
    });

    it("removeOrphans 只清理未被引用的附件，可重复执行", async () => {
      const store = await makeStore();
      const make = (name: string) =>
        store.add({
          pageId: "page-1",
          name,
          mimeType: "text/plain",
          size: 1,
          data: bytes(1),
        });
      const keep = await make("保留.txt");
      await make("孤儿A.txt");
      await make("孤儿B.txt");

      expect(await store.removeOrphans("page-1", [keep.id])).toBe(2);
      expect((await store.listByDocument("page-1")).map((a) => a.id)).toEqual([
        keep.id,
      ]);
      expect(await store.removeOrphans("page-1", [keep.id])).toBe(0);
    });

    it("removeOrphans 时间边界：快照之后新建的附件不清理（R004 INV-03）", async () => {
      const store = await makeStore();
      const oldOrphan = await store.add({
        pageId: "page-1",
        name: "旧孤儿.txt",
        mimeType: "text/plain",
        size: 1,
        data: bytes(1),
      });
      const capturedAt = Date.now();
      // 跨过毫秒边界，保证新附件 createdAt 严格晚于 capturedAt。
      await new Promise((resolve) => setTimeout(resolve, 5));
      const newAttachment = await store.add({
        pageId: "page-1",
        name: "新附件.txt",
        mimeType: "text/plain",
        size: 1,
        data: bytes(1),
      });

      expect(
        await store.removeOrphans("page-1", [], {
          createdBeforeOrAt: capturedAt,
        }),
      ).toBe(1);
      expect((await store.listByDocument("page-1")).map((a) => a.id)).toEqual([
        newAttachment.id,
      ]);
      expect(await store.getMetadata(oldOrphan.id)).toBeUndefined();
      // 不传时间边界时清理全部未引用附件。
      expect(await store.removeOrphans("page-1", [])).toBe(1);
      expect(await store.listByDocument("page-1")).toEqual([]);
    });
  });
}
