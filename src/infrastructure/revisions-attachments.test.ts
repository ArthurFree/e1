import { beforeEach, describe, expect, it } from "vitest";
import { getDB, resetDB, STORE_ATTACHMENTS, STORE_REVISIONS } from "./db";
import {
  attachmentRepository,
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

    const added = await revisionRepository.add(doc.id, { v: 3 }, "三", "manual");
    expect(added).not.toBeNull();
    expect((await revisionRepository.listByPage(doc.id))[0].id).toBe(added!.id);
  });

  it("相邻版本内容一致时不重复创建", async () => {
    const doc = await seedDoc();
    const content = { type: "doc", content: [] };
    await revisionRepository.add(doc.id, content, "快照", "interval");
    const dup = await revisionRepository.add(doc.id, content, "快照", "interval");
    expect(dup).toBeNull();
    expect(await revisionRepository.listByPage(doc.id)).toHaveLength(1);

    const changed = await revisionRepository.add(doc.id, { type: "doc", content: [{}] }, "变了", "interval");
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

  it("损坏的版本记录被跳过", async () => {
    const doc = await seedDoc();
    const db = await getDB();
    await db.put(STORE_REVISIONS, { id: "bad", pageId: doc.id, reason: "unknown" });
    await revisionRepository.add(doc.id, { v: 1 }, "一", "interval");

    const list = await revisionRepository.listByPage(doc.id);
    expect(list).toHaveLength(1);
    expect(list[0].reason).toBe("interval");
  });
});

describe("附件仓储", () => {
  it("附件写入后可读取与列出", async () => {
    const doc = await seedDoc();
    const blob = new Blob(["hello"], { type: "text/plain" });
    const attachment = await attachmentRepository.add({
      pageId: doc.id,
      name: "说明.txt",
      mimeType: "text/plain",
      size: 5,
      blob,
    });

    const stored = await attachmentRepository.get(attachment.id);
    expect(stored?.name).toBe("说明.txt");
    expect(stored?.mimeType).toBe("text/plain");
    expect(stored?.size).toBe(5);
    // 注：fake-indexeddb + jsdom 无法结构化克隆 Blob 内容（克隆为空对象），
    // Blob 内容往返只在真实浏览器验证；此处验证元数据与记录可读。

    const list = await attachmentRepository.listByPage(doc.id);
    expect(list.map((a) => a.id)).toEqual([attachment.id]);
  });

  it("remove 删除附件，removeOrphans 只清理未被引用的附件", async () => {
    const doc = await seedDoc();
    const make = (name: string) =>
      attachmentRepository.add({
        pageId: doc.id,
        name,
        mimeType: "text/plain",
        size: 1,
        blob: new Blob(["x"]),
      });
    const keep = await make("保留.txt");
    const orphanA = await make("孤儿A.txt");
    const orphanB = await make("孤儿B.txt");

    const removed = await attachmentRepository.removeOrphans(doc.id, [keep.id]);
    expect(removed).toBe(2);
    expect((await attachmentRepository.listByPage(doc.id)).map((a) => a.id)).toEqual([keep.id]);
    // 再次执行无副作用。
    expect(await attachmentRepository.removeOrphans(doc.id, [keep.id])).toBe(0);

    await attachmentRepository.remove(keep.id);
    expect(await attachmentRepository.get(keep.id)).toBeUndefined();
    expect(orphanA.id).not.toBe(orphanB.id);
  });

  it("损坏的附件记录被跳过", async () => {
    const doc = await seedDoc();
    const db = await getDB();
    await db.put(STORE_ATTACHMENTS, { id: "bad", pageId: doc.id, name: 123 });
    expect(await attachmentRepository.listByPage(doc.id)).toEqual([]);
    expect(await attachmentRepository.get("bad")).toBeUndefined();
  });
});

describe("永久删除级联", () => {
  it("purge 级联删除版本与附件", async () => {
    const doc = await seedDoc();
    await contentRepository.save(doc.id, { type: "doc" }, "正文");
    await revisionRepository.add(doc.id, { type: "doc" }, "正文", "interval");
    await attachmentRepository.add({
      pageId: doc.id,
      name: "附件.txt",
      mimeType: "text/plain",
      size: 1,
      blob: new Blob(["x"]),
    });

    await pageRepository.remove(doc.id);
    // 回收站内保留，恢复可用。
    expect(await revisionRepository.listByPage(doc.id)).toHaveLength(1);
    expect(await attachmentRepository.listByPage(doc.id)).toHaveLength(1);

    await pageRepository.purge(doc.id);
    expect(await revisionRepository.listByPage(doc.id)).toEqual([]);
    expect(await attachmentRepository.listByPage(doc.id)).toEqual([]);
    expect(await contentRepository.get(doc.id)).toBeUndefined();
  });
});
