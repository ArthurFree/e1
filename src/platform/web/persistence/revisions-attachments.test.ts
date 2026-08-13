import { beforeEach, describe, expect, it } from "vitest";
import { getDB, resetDB, STORE_ATTACHMENTS, STORE_REVISIONS } from "./db";
import { sleep } from "../../../test/fixtures";
import {
  assetStore,
  contentRepository,
  pageRepository,
  revisionRepository,
  workspaceRepository,
} from "./repositories";

beforeEach(async () => {
  await resetDB();
});

async function seedDoc(title = "文档") {
  const [ws] = await workspaceRepository.list();
  return pageRepository.create({
    workspaceId: ws.id,
    parentId: null,
    kind: "document",
    title,
  });
}

describe("版本仓储", () => {
  it("新增版本并按创建时间倒序列出", async () => {
    const doc = await seedDoc();
    const db = await getDB();
    // 直接写入可控时间戳，避免同一毫秒内排序不稳定。
    for (const [id, createdAt, text] of [
      ["r-old", 1000, "一"],
      ["r-new", 2000, "二"],
    ] as const) {
      await db.put(STORE_REVISIONS, {
        id,
        pageId: doc.id,
        contentJson: { v: id },
        textSnapshot: text,
        createdAt,
        reason: "interval",
      });
    }

    const list = await revisionRepository.listByPage(doc.id);
    expect(list.map((r) => r.id)).toEqual(["r-new", "r-old"]);
    expect(list[1].textSnapshot).toBe("一");

    const added = await revisionRepository.add(
      doc.id,
      { v: 3 },
      "三",
      "manual",
    );
    expect(added).not.toBeNull();
    expect((await revisionRepository.listByPage(doc.id))[0].id).toBe(added!.id);
  });

  it("相邻版本内容一致时不重复创建", async () => {
    const doc = await seedDoc();
    const content = { type: "doc", content: [] };
    await revisionRepository.add(doc.id, content, "快照", "interval");
    const dup = await revisionRepository.add(
      doc.id,
      content,
      "快照",
      "interval",
    );
    expect(dup).toBeNull();
    expect(await revisionRepository.listByPage(doc.id)).toHaveLength(1);

    const changed = await revisionRepository.add(
      doc.id,
      { type: "doc", content: [{}] },
      "变了",
      "interval",
    );
    expect(changed).not.toBeNull();
    expect(await revisionRepository.listByPage(doc.id)).toHaveLength(2);
  });

  it("pruneInterval 只裁剪超额的 interval 版本", async () => {
    const doc = await seedDoc();
    const db = await getDB();
    // 直接写入带可控时间戳的记录：5 个 interval + 1 个 manual + 1 个 before-restore。
    for (let i = 0; i < 5; i += 1) {
      await db.put(STORE_REVISIONS, {
        id: `r-${i}`,
        pageId: doc.id,
        contentJson: { v: i },
        textSnapshot: `v${i}`,
        createdAt: 1000 + i,
        reason: "interval",
      });
    }
    await db.put(STORE_REVISIONS, {
      id: "r-manual",
      pageId: doc.id,
      contentJson: { v: "m" },
      textSnapshot: "m",
      createdAt: 500,
      reason: "manual",
    });
    await db.put(STORE_REVISIONS, {
      id: "r-restore",
      pageId: doc.id,
      contentJson: { v: "b" },
      textSnapshot: "b",
      createdAt: 400,
      reason: "before-restore",
    });

    await revisionRepository.pruneInterval(doc.id, 2);
    const list = await revisionRepository.listByPage(doc.id);
    expect(list).toHaveLength(4);
    const interval = list.filter((r) => r.reason === "interval");
    // 保留最新的两个 interval。
    expect(interval.map((r) => r.id)).toEqual(["r-4", "r-3"]);
    expect(list.some((r) => r.id === "r-manual")).toBe(true);
    expect(list.some((r) => r.id === "r-restore")).toBe(true);
  });

  it("pruneInterval 在数量上限之外按总字节预算裁剪（R004 阶段 6）", async () => {
    const doc = await seedDoc();
    const db = await getDB();
    // 每条 contentJson 序列化约 112 字节；预算 250 → 保留最新两条，更旧的删除。
    const pad = "x".repeat(100);
    for (let i = 0; i < 4; i += 1) {
      await db.put(STORE_REVISIONS, {
        id: `r-${i}`,
        pageId: doc.id,
        contentJson: { pad, v: i },
        textSnapshot: `v${i}`,
        createdAt: 1000 + i,
        reason: "interval",
      });
    }
    // manual 版本不参与自动清理，即使它在预算之外。
    await db.put(STORE_REVISIONS, {
      id: "r-manual",
      pageId: doc.id,
      contentJson: { pad, v: "m" },
      textSnapshot: "m",
      createdAt: 500,
      reason: "manual",
    });

    // 数量上限足够大（不起作用），仅靠字节预算裁剪。
    await revisionRepository.pruneInterval(doc.id, 100, 250);
    const list = await revisionRepository.listByPage(doc.id);
    expect(list.map((r) => r.id).sort()).toEqual(["r-2", "r-3", "r-manual"]);
  });

  it("pruneInterval 字节预算下最新版本始终保留", async () => {
    const doc = await seedDoc();
    const db = await getDB();
    const big = "x".repeat(1024);
    for (const [id, createdAt] of [
      ["r-old", 1000],
      ["r-big", 2000],
    ] as const) {
      await db.put(STORE_REVISIONS, {
        id,
        pageId: doc.id,
        contentJson: { big },
        textSnapshot: id,
        createdAt,
        reason: "interval",
      });
    }
    // 预算远小于单条版本：最新的仍保留，更旧的删除。
    await revisionRepository.pruneInterval(doc.id, 100, 10);
    const list = await revisionRepository.listByPage(doc.id);
    expect(list.map((r) => r.id)).toEqual(["r-big"]);
  });

  it("损坏的版本记录被跳过", async () => {
    const doc = await seedDoc();
    const db = await getDB();
    await db.put(STORE_REVISIONS, {
      id: "bad",
      pageId: doc.id,
      reason: "unknown",
    });
    await revisionRepository.add(doc.id, { v: 1 }, "一", "interval");

    const list = await revisionRepository.listByPage(doc.id);
    expect(list).toHaveLength(1);
    expect(list[0].reason).toBe("interval");
  });
});

describe("附件仓储", () => {
  it("附件写入后可读取与列出", async () => {
    const doc = await seedDoc();
    // R005 阶段 5：字节以 Uint8Array 落库，fake-indexeddb 可完整往返。
    const attachment = await assetStore.add({
      pageId: doc.id,
      name: "说明.txt",
      mimeType: "text/plain",
      size: 5,
      data: new Uint8Array([104, 101, 108, 108, 111]),
    });

    const stored = await assetStore.getMetadata(attachment.id);
    expect(stored?.name).toBe("说明.txt");
    expect(stored?.mimeType).toBe("text/plain");
    expect(stored?.size).toBe(5);
    // 字节级往返（getBinary）。
    const binary = await assetStore.getBinary(attachment.id);
    expect([...(binary?.data ?? [])]).toEqual([104, 101, 108, 108, 111]);

    const list = await assetStore.listByDocument(doc.id);
    expect(list.map((a) => a.id)).toEqual([attachment.id]);
  });

  it("remove 删除附件，removeOrphans 只清理未被引用的附件", async () => {
    const doc = await seedDoc();
    const make = (name: string) =>
      assetStore.add({
        pageId: doc.id,
        name,
        mimeType: "text/plain",
        size: 1,
        data: new Uint8Array([120]),
      });
    const keep = await make("保留.txt");
    const orphanA = await make("孤儿A.txt");
    const orphanB = await make("孤儿B.txt");

    const removed = await assetStore.removeOrphans(doc.id, [keep.id]);
    expect(removed).toBe(2);
    expect((await assetStore.listByDocument(doc.id)).map((a) => a.id)).toEqual([
      keep.id,
    ]);
    // 再次执行无副作用。
    expect(await assetStore.removeOrphans(doc.id, [keep.id])).toBe(0);

    await assetStore.remove(keep.id);
    expect(await assetStore.getMetadata(keep.id)).toBeUndefined();
    expect(orphanA.id).not.toBe(orphanB.id);
  });

  it("removeOrphans 时间边界：快照之后新建的附件不清理（R004 INV-03）", async () => {
    const doc = await seedDoc();
    const make = (name: string) =>
      assetStore.add({
        pageId: doc.id,
        name,
        mimeType: "text/plain",
        size: 1,
        data: new Uint8Array([120]),
      });
    // capturedAt 之前已存在的孤儿：允许清理。
    const oldOrphan = await make("旧孤儿.txt");
    const capturedAt = Date.now();
    // 跨过毫秒边界，保证新附件 createdAt 严格晚于 capturedAt。
    await sleep(5);
    // capturedAt 之后新建的附件：即使未被引用也不得删除。
    const newAttachment = await make("新附件.txt");

    const removed = await assetStore.removeOrphans(doc.id, [], {
      createdBeforeOrAt: capturedAt,
    });
    expect(removed).toBe(1);
    expect((await assetStore.listByDocument(doc.id)).map((a) => a.id)).toEqual([
      newAttachment.id,
    ]);
    expect(await assetStore.getMetadata(oldOrphan.id)).toBeUndefined();
    // 不传时间边界时保持原语义：清理全部未引用附件。
    expect(await assetStore.removeOrphans(doc.id, [])).toBe(1);
    expect((await assetStore.listByDocument(doc.id)).length).toBe(0);
  });

  it("损坏的附件记录被跳过", async () => {
    const doc = await seedDoc();
    const db = await getDB();
    await db.put(STORE_ATTACHMENTS, { id: "bad", pageId: doc.id, name: 123 });
    expect(await assetStore.listByDocument(doc.id)).toEqual([]);
    expect(await assetStore.getMetadata("bad")).toBeUndefined();
  });
});

describe("永久删除级联", () => {
  it("purge 级联删除版本与附件", async () => {
    const doc = await seedDoc();
    await contentRepository.save(doc.id, { type: "doc" }, "正文", "idb:1");
    await revisionRepository.add(doc.id, { type: "doc" }, "正文", "interval");
    await assetStore.add({
      pageId: doc.id,
      name: "附件.txt",
      mimeType: "text/plain",
      size: 1,
      data: new Uint8Array([120]),
    });

    await pageRepository.remove(doc.id);
    // 回收站内保留，恢复可用。
    expect(await revisionRepository.listByPage(doc.id)).toHaveLength(1);
    expect(await assetStore.listByDocument(doc.id)).toHaveLength(1);

    await pageRepository.purge(doc.id);
    expect(await revisionRepository.listByPage(doc.id)).toEqual([]);
    expect(await assetStore.listByDocument(doc.id)).toEqual([]);
    expect(await contentRepository.get(doc.id)).toBeUndefined();
  });
});
