/**
 * DocumentCommitService 单元测试（R004 阶段 2；R005 阶段 6 适配 SearchIndexPort）：
 * 正文提交后搜索索引同步（INV-05）——commit / createWithContent /
 * replaceContent 三条路径写入后立即可搜；索引同步失败不影响保存结果。
 * 使用内存仓储 + 真实 BrowserMemorySearchIndex（Web 内存实现）。
 */
import { describe, expect, it, vi } from "vitest";
import { createInMemoryRepositories } from "../../infrastructure/memory/repositories";
import { BrowserMemorySearchIndex } from "../../platform/web/search/BrowserMemorySearchIndex";
import type { SearchIndexPort } from "./SearchIndexPort";
import { DocumentCommitService } from "./DocumentCommitService";

const DOC_A = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "甲正文关键词" }] },
  ],
};

function makeService() {
  const repos = createInMemoryRepositories();
  const searchIndex = new BrowserMemorySearchIndex({
    pages: repos.page,
    content: repos.content,
  });
  const service = new DocumentCommitService({
    content: repos.content,
    documentWrite: repos.documentWrite,
    revisions: repos.revision,
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
    await searchIndex.prepareWorkspace(ws.id);

    // 页面创建时已写入首版空正文：以其版本令牌为首次提交的 expectedVersion。
    const initialToken = (await repos.content.get(page.id))!.version;
    const { savedAt } = await service.commit(
      page.id,
      DOC_A,
      "甲正文关键词",
      initialToken,
    );
    expect(typeof savedAt).toBe("number");
    expect((await repos.content.get(page.id))?.textSnapshot).toBe(
      "甲正文关键词",
    );
    const hits = await searchIndex.query(ws.id, "关键词");
    expect(hits.map((h) => h.pageId)).toContain(page.id);
  });

  it("createWithContent 原子创建后立即可搜标题与正文", async () => {
    const { repos, searchIndex, service } = makeService();
    const ws = await repos.workspace.create("知识库");
    await searchIndex.prepareWorkspace(ws.id);

    const page = await service.createWithContent({
      workspaceId: ws.id,
      parentId: null,
      title: "乙标题命中",
      contentJson: DOC_A,
      textSnapshot: "甲正文关键词",
    });

    expect((await repos.content.get(page.id))?.textSnapshot).toBe(
      "甲正文关键词",
    );
    expect(
      (await searchIndex.query(ws.id, "乙标题")).map((h) => h.pageId),
    ).toContain(page.id);
    expect(
      (await searchIndex.query(ws.id, "关键词")).map((h) => h.pageId),
    ).toContain(page.id);
  });

  it("replaceContent 覆盖后索引命中新文本、不再命中旧文本", async () => {
    const { repos, searchIndex, service } = makeService();
    const ws = await repos.workspace.create("知识库");
    // 索引桶须先存在（会话加载时 prepareWorkspace），upsert/updateText 才生效。
    await searchIndex.prepareWorkspace(ws.id);
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

    expect(
      (await searchIndex.query(ws.id, "新文本")).map((h) => h.pageId),
    ).toContain(page.id);
    expect(await searchIndex.query(ws.id, "旧文本")).toHaveLength(0);
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
    expect(await searchIndex.query("ws-missing", "关键词")).toHaveLength(0);
  });

  it("索引同步失败不影响保存结果（R005 阶段 6 容错语义）", async () => {
    const repos = createInMemoryRepositories();
    // 所有 port 调用立即拒绝的故障索引。
    const failingIndex: SearchIndexPort = {
      prepareWorkspace: () => Promise.reject(new Error("索引故障")),
      rebuild: () => Promise.reject(new Error("索引故障")),
      syncPages: () => Promise.reject(new Error("索引故障")),
      upsertDocument: () => Promise.reject(new Error("索引故障")),
      updateText: () => Promise.reject(new Error("索引故障")),
      removeDocument: () => Promise.reject(new Error("索引故障")),
      has: () => false,
      query: () => Promise.resolve([]),
    };
    const service = new DocumentCommitService({
      content: repos.content,
      documentWrite: repos.documentWrite,
      revisions: repos.revision,
      searchIndex: failingIndex,
    });

    const ws = await repos.workspace.create("知识库");
    const page = await service.createWithContent({
      workspaceId: ws.id,
      parentId: null,
      title: "文档",
      contentJson: DOC_A,
      textSnapshot: "旧文本甲",
    });
    const token = (await repos.content.get(page.id))!.version;
    // commit / replaceContent 均正常返回，不抛索引故障。
    const committed = await service.commit(page.id, DOC_A, "新文本乙", token);
    expect(typeof committed.savedAt).toBe("number");
    await service.replaceContent({
      pageId: page.id,
      contentJson: DOC_A,
      textSnapshot: "新文本丙",
    });
    expect((await repos.content.get(page.id))?.textSnapshot).toBe("新文本丙");
  });

  it("restoreRevision：当前内容存 before-restore，目标经提交通道落盘（INV-06）", async () => {
    const { repos, service } = makeService();
    const ws = await repos.workspace.create("知识库");
    const page = await repos.page.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "文档",
    });
    const current = {
      contentJson: { type: "doc", content: [] },
      textSnapshot: "当前内容",
    };
    const commits: { json: unknown; text: string }[] = [];
    await service.restoreRevision({
      pageId: page.id,
      current,
      target: { contentJson: DOC_A, textSnapshot: "历史内容" },
      commit: (contentJson, textSnapshot) => {
        commits.push({ json: contentJson, text: textSnapshot });
        return Promise.resolve();
      },
    });

    // before-restore 版本保存的是恢复前的当前内容。
    const revisions = await repos.revision.listByPage(page.id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].reason).toBe("before-restore");
    expect(revisions[0].textPreview).toBe("当前内容");
    // 目标版本经调用方提交通道（保存协调器）串行落盘。
    expect(commits).toEqual([{ json: DOC_A, text: "历史内容" }]);
  });

  it("restoreRevision：before-restore 先于恢复提交，且不受 interval 节流（R012 §34）", async () => {
    const { repos, service } = makeService();
    const ws = await repos.workspace.create("知识库");
    const page = await repos.page.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "文档",
    });
    // 记录 add / commit 的调用顺序。
    const order: string[] = [];
    const originalAdd = repos.revision.add.bind(repos.revision);
    const addSpy = vi
      .spyOn(repos.revision, "add")
      .mockImplementation(async (...args) => {
        order.push("add");
        return originalAdd(...args);
      });

    // 连续两次恢复（间隔远小于 5 分钟）：before-restore 不走 interval 门控，
    // 每次都创建快照（Desktop 下同——capture 由 Main 读盘，绕过 5 分钟节流）。
    // 注意内容需不同：仓储按内容与最新快照去重（add → null）。
    const contents = [DOC_A, { type: "doc", content: [] }];
    for (const [index, text] of ["恢复前内容一", "恢复前内容二"].entries()) {
      await service.restoreRevision({
        pageId: page.id,
        current: { contentJson: contents[index], textSnapshot: text },
        target: { contentJson: DOC_A, textSnapshot: "历史内容" },
        commit: () => {
          order.push("commit");
          return Promise.resolve();
        },
      });
    }

    expect(order).toEqual(["add", "commit", "add", "commit"]);
    const revisions = await repos.revision.listByPage(page.id);
    expect(revisions.map((r) => r.reason)).toEqual([
      "before-restore",
      "before-restore",
    ]);
    addSpy.mockRestore();
  });

  it("restoreRevision：before-restore 快照失败时不落盘目标内容（安全网优先）", async () => {
    const { repos, service } = makeService();
    const ws = await repos.workspace.create("知识库");
    const page = await repos.page.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "文档",
    });
    // Desktop 下 before-restore 经 IPC capture，失败（如 VAULT_READ_ONLY）
    // 必须中止恢复——不丢当前内容的安全网没搭好就不允许覆盖。
    const addSpy = vi
      .spyOn(repos.revision, "add")
      .mockRejectedValue(new Error("capture IPC 失败"));
    const commits: unknown[] = [];

    await expect(
      service.restoreRevision({
        pageId: page.id,
        current: { contentJson: DOC_A, textSnapshot: "当前内容" },
        target: { contentJson: DOC_A, textSnapshot: "历史内容" },
        commit: () => {
          commits.push(1);
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow("capture IPC 失败");
    expect(commits).toEqual([]);
    addSpy.mockRestore();
  });
});
