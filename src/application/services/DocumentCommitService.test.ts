/**
 * DocumentCommitService 单元测试（R004 阶段 2）：
 * 正文提交后搜索索引同步（INV-05）——commit / createWithContent /
 * replaceContent 三条路径写入后立即可搜。使用内存仓储 + 真实 SearchIndexService。
 */
import { describe, expect, it } from "vitest";
import { createInMemoryRepositories } from "../../infrastructure/memory/repositories";
import { SearchIndexService } from "./SearchIndexService";
import { DocumentCommitService } from "./DocumentCommitService";

const DOC_A = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "甲正文关键词" }] },
  ],
};

function makeService() {
  const repos = createInMemoryRepositories();
  const searchIndex = new SearchIndexService();
  const service = new DocumentCommitService({
    content: repos.content,
    documentWrite: repos.documentWrite,
    searchIndex,
  });
  return { repos, searchIndex, service };
}

describe("DocumentCommitService", () => {
  it("commit 落盘并同步搜索索引（INV-05）", async () => {
    const { repos, searchIndex, service } = makeService();
    const ws = await repos.workspace.create("知识库");
    const page = await repos.page.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "文档",
    });
    searchIndex.build(ws.id, await repos.page.listByWorkspace(ws.id), []);

    const { savedAt } = await service.commit(page.id, DOC_A, "甲正文关键词");
    expect(typeof savedAt).toBe("number");
    expect((await repos.content.get(page.id))?.textSnapshot).toBe("甲正文关键词");
    const hits = searchIndex.query(ws.id, "关键词");
    expect(hits.map((h) => h.pageId)).toContain(page.id);
  });

  it("createWithContent 原子创建后立即可搜标题与正文", async () => {
    const { repos, searchIndex, service } = makeService();
    const ws = await repos.workspace.create("知识库");
    searchIndex.build(ws.id, await repos.page.listByWorkspace(ws.id), []);

    const page = await service.createWithContent({
      workspaceId: ws.id,
      parentId: null,
      title: "乙标题命中",
      contentJson: DOC_A,
      textSnapshot: "甲正文关键词",
    });

    expect((await repos.content.get(page.id))?.textSnapshot).toBe("甲正文关键词");
    expect(searchIndex.query(ws.id, "乙标题").map((h) => h.pageId)).toContain(page.id);
    expect(searchIndex.query(ws.id, "关键词").map((h) => h.pageId)).toContain(page.id);
  });

  it("replaceContent 覆盖后索引命中新文本、不再命中旧文本", async () => {
    const { repos, searchIndex, service } = makeService();
    const ws = await repos.workspace.create("知识库");
    // 索引桶须先存在（会话加载时 build），upsertPage/updateText 才生效。
    searchIndex.build(ws.id, [], []);
    const page = await service.createWithContent({
      workspaceId: ws.id,
      parentId: null,
      title: "文档",
      contentJson: DOC_A,
      textSnapshot: "旧文本甲",
    });

    const next = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "新文本丙" }] },
      ],
    };
    await service.replaceContent({
      pageId: page.id,
      contentJson: next,
      textSnapshot: "新文本丙",
    });

    expect(searchIndex.query(ws.id, "新文本").map((h) => h.pageId)).toContain(page.id);
    expect(searchIndex.query(ws.id, "旧文本")).toHaveLength(0);
  });

  it("写入失败时索引不产生脏条目", async () => {
    const { searchIndex, service } = makeService();
    await expect(
      service.createWithContent({
        workspaceId: "ws-missing",
        parentId: null,
        title: "孤儿",
        contentJson: DOC_A,
        textSnapshot: "甲正文关键词",
      }),
    ).rejects.toThrow();
    expect(searchIndex.query("ws-missing", "关键词")).toHaveLength(0);
  });
});
