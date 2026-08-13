/**
 * 查询服务双实现测试（R005 批次 1）：WorkspaceQueryService 的会话加载
 * 构建搜索索引、loadPages 同步索引、loadTags 并行查询，以及
 * SearchQueryService 的索引/全量回退双路径；IndexedDB（fake-indexeddb）
 * 与内存两套装配跑同一组断言。
 */
import { describe, expect, it } from "vitest";
import type {
  ContentRepository,
  PageRepository,
  TagRepository,
  WorkspaceRepository,
} from "../../domain/repositories";
import { resetDB } from "../../infrastructure/db";
import {
  contentRepository as idbContent,
  pageRepository as idbPage,
  revisionRepository as idbRevision,
  tagRepository as idbTag,
  workspaceRepository as idbWorkspace,
} from "../../infrastructure/repositories";
import { createInMemoryAppServices } from "../../infrastructure/memory/createInMemoryAppServices";
import { BrowserMemorySearchIndex } from "../../platform/web/search/BrowserMemorySearchIndex";
import {
  DesktopContentRepository,
  DesktopVaultScanCache,
} from "../../platform/desktop/repositories";
import { DesktopRevisionRepository } from "../../platform/desktop/stubRepositories";
import type { E1DesktopAPI } from "../../platform/desktop/desktopApi";
import { WorkspaceSessionService } from "../services/WorkspaceSessionService";
import { WorkspaceQueryService } from "./WorkspaceQueryService";
import { DocumentQueryService } from "./DocumentQueryService";
import { SearchQueryService } from "./SearchQueryService";

const DOC_WITH_KEYWORD = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "正文关键词甲" }] },
  ],
};

interface QueryTestContext {
  queries: {
    workspace: WorkspaceQueryService;
    search: SearchQueryService;
  };
  searchIndex: BrowserMemorySearchIndex;
  repos: {
    workspace: WorkspaceRepository;
    page: PageRepository;
    content: ContentRepository;
    tag: TagRepository;
  };
}

/** IndexedDB 装配（fake-indexeddb）。 */
async function makeBrowserContext(): Promise<QueryTestContext> {
  await resetDB();
  const searchIndex = new BrowserMemorySearchIndex({
    pages: idbPage,
    content: idbContent,
  });
  const session = new WorkspaceSessionService({
    pages: idbPage,
    tags: idbTag,
  });
  return {
    queries: {
      workspace: new WorkspaceQueryService({
        workspace: idbWorkspace,
        page: idbPage,
        tag: idbTag,
        session,
        searchIndex,
      }),
      search: new SearchQueryService({ searchIndex, content: idbContent }),
    },
    searchIndex,
    repos: {
      workspace: idbWorkspace,
      page: idbPage,
      content: idbContent,
      tag: idbTag,
    },
  };
}

/** 内存装配。 */
function makeMemoryContext(): QueryTestContext {
  const { services } = createInMemoryAppServices();
  return {
    queries: {
      workspace: services.queries.workspace,
      search: services.queries.search,
    },
    searchIndex: services.searchIndex,
    repos: {
      workspace: services.workspace,
      page: services.page,
      content: services.content,
      tag: services.tag,
    },
  };
}

/** 预置「知识库 + 含关键词正文的文档」。 */
async function seedKeywordDocument(ctx: QueryTestContext) {
  const ws = await ctx.repos.workspace.create("知识库");
  const page = await ctx.repos.page.create({
    workspaceId: ws.id,
    parentId: null,
    kind: "document",
    title: "普通标题",
  });
  // 页面创建时已写入首版空正文：以其版本令牌为首次保存的 expectedVersion
  // （R005 阶段 3：令牌不透明，从仓储读出后原样传递，不断言具体编码）。
  const initialToken = (await ctx.repos.content.get(page.id))!.version;
  await ctx.repos.content.save(
    page.id,
    DOC_WITH_KEYWORD,
    "正文关键词甲",
    initialToken,
  );
  return { ws, page };
}

function describeQueryServices(
  name: string,
  makeContext: () => QueryTestContext | Promise<QueryTestContext>,
): void {
  describe(`查询服务（${name}）`, () => {
    it("loadSession 返回会话数据（不含正文）并准备搜索索引", async () => {
      const ctx = await makeContext();
      const { ws, page } = await seedKeywordDocument(ctx);
      const data = await ctx.queries.workspace.loadSession(ws.id);
      expect(data.workspaceId).toBe(ws.id);
      expect(data.pages.map((p) => p.id)).toContain(page.id);
      // R005 阶段 6：会话数据不再携带全部正文，索引自行取数。
      expect(data).not.toHaveProperty("contents");
      expect(ctx.searchIndex.has(ws.id)).toBe(true);
      const hits = await ctx.searchIndex.query(ws.id, "关键词");
      expect(hits.map((h) => h.pageId)).toContain(page.id);
    });

    it("loadPages 返回页面镜像并同步搜索索引元数据", async () => {
      const ctx = await makeContext();
      const { ws, page } = await seedKeywordDocument(ctx);
      await ctx.queries.workspace.loadSession(ws.id);
      // 绕过命令服务直接改标题，loadPages 应把新标题同步进索引。
      await ctx.repos.page.rename(page.id, "改名后标题");
      const pages = await ctx.queries.workspace.loadPages(ws.id);
      expect(pages.find((p) => p.id === page.id)?.title).toBe("改名后标题");
      const hits = await ctx.searchIndex.query(ws.id, "改名后标题");
      expect(hits.map((h) => h.pageId)).toContain(page.id);
    });

    it("loadTags 并行返回标签与页面-标签关联", async () => {
      const ctx = await makeContext();
      const ws = await ctx.repos.workspace.create("知识库");
      const page = await ctx.repos.page.create({
        workspaceId: ws.id,
        parentId: null,
        kind: "document",
        title: "文档",
      });
      const tag = await ctx.repos.tag.create(ws.id, "标签甲", "#22A06B");
      await ctx.repos.tag.setPageTags(page.id, [tag.id]);

      const { tags, pageTags } = await ctx.queries.workspace.loadTags(ws.id);
      expect(tags.map((t) => t.id)).toContain(tag.id);
      expect(pageTags).toContainEqual({
        pageId: page.id,
        tagId: tag.id,
        workspaceId: ws.id,
      });
    });

    it("findPage 跨知识库查找单页；不存在时返回 undefined", async () => {
      const ctx = await makeContext();
      const ws = await ctx.repos.workspace.create("知识库");
      const page = await ctx.repos.page.create({
        workspaceId: ws.id,
        parentId: null,
        kind: "document",
        title: "文档",
      });
      expect((await ctx.queries.workspace.findPage(page.id))?.title).toBe(
        "文档",
      );
      expect(
        await ctx.queries.workspace.findPage("page-missing"),
      ).toBeUndefined();
    });

    it("search 走内存索引路径（索引已构建）", async () => {
      const ctx = await makeContext();
      const { ws, page } = await seedKeywordDocument(ctx);
      await ctx.queries.workspace.loadSession(ws.id);
      const results = await ctx.queries.search.query(ws.id, [page], "关键词");
      expect(results.map((r) => r.pageId)).toContain(page.id);
    });

    it("search 回退全量扫描路径（索引未构建），结果与索引路径等价", async () => {
      const ctx = await makeContext();
      const { ws, page } = await seedKeywordDocument(ctx);
      // 不调用 loadSession：索引未构建，走 content.listAll + searchPages。
      expect(ctx.searchIndex.has(ws.id)).toBe(false);
      const fallback = await ctx.queries.search.query(ws.id, [page], "关键词");
      expect(fallback.map((r) => r.pageId)).toContain(page.id);

      // 构建索引后同查询，两条路径结果一致。
      await ctx.queries.workspace.loadSession(ws.id);
      const indexed = await ctx.queries.search.query(ws.id, [page], "关键词");
      expect(indexed).toEqual(fallback);
    });
  });
}

describeQueryServices("IndexedDB", makeBrowserContext);
describeQueryServices("内存", makeMemoryContext);

/**
 * DocumentQueryService.openDocument 三形态（R006-C3 §41.6 / FR-17/18）：
 * Web 默认包装 editable/lossy:false；仓储实现 DocumentOpenCapable（Desktop）
 * 时委托其真实打开语义——兼容 editable/lossy:false，不支持 read-only/lossy:true。
 */
describe("DocumentQueryService.openDocument（§41.6 三形态）", () => {
  /** Desktop 装配：扫描一条文档 + note.read 返回指定 markdown。 */
  async function makeDesktopService(
    markdown: string,
    options?: { stableNoteId?: string | null; vaultId?: string },
  ) {
    const vaultId = options?.vaultId ?? "v1";
    const stableNoteId =
      options?.stableNoteId !== undefined ? options.stableNoteId : "01JABC";
    const api = {
      vault: {
        scan: async () => ({
          vault: { vaultId, name: "我的笔记" },
          entries: [
            {
              noteId: "01JABC",
              relativePath: "React.md",
              kind: "document" as const,
              title: "React 笔记",
              parentPath: null,
              tags: [],
            },
          ],
        }),
      },
      note: {
        read: async () => ({
          stableNoteId,
          relativePath: "React.md",
          markdown,
          versionToken: `sha256:${"b".repeat(64)}`,
          source: { modifiedAt: 1722580000000, sizeBytes: 64 },
        }),
      },
    } as unknown as E1DesktopAPI;
    const cache = new DesktopVaultScanCache(api);
    const service = new DocumentQueryService({
      content: new DesktopContentRepository(api, cache),
      revisions: new DesktopRevisionRepository(),
    });
    await cache.scan(vaultId);
    return service;
  }

  it("Web（IndexedDB）：editable + writePolicy read-write；正文缺失返回 null", async () => {
    await resetDB();
    const service = new DocumentQueryService({
      content: idbContent,
      revisions: idbRevision,
    });
    const ws = await idbWorkspace.create("知识库");
    const page = await idbPage.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "文档",
    });
    const initial = (await idbContent.get(page.id))!;
    await idbContent.save(
      page.id,
      DOC_WITH_KEYWORD,
      "正文关键词甲",
      initial.version,
    );

    const opened = await service.openDocument(page.id);
    expect(opened?.access).toBe("editable");
    expect(opened?.writePolicy).toEqual({ mode: "read-write" });
    expect(opened?.compatibility).toEqual({ lossy: false, unsupported: [] });
    expect(opened?.content.textSnapshot).toBe("正文关键词甲");
    expect(opened?.source.versionToken).toBe(
      (await idbContent.get(page.id))!.version,
    );
    // 无正文 = 新文档语义：返回 null 由调用方以空文档兜底。
    expect(await service.openDocument("page-missing")).toBeNull();
  });

  it("Web（内存容器）：editable + writePolicy read-write", async () => {
    const { services } = createInMemoryAppServices();
    const ws = await services.workspace.create("知识库");
    const page = await services.page.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "文档",
    });
    const opened = await services.queries.document.openDocument(page.id);
    expect(opened).toMatchObject({
      access: "editable",
      writePolicy: { mode: "read-write" },
      compatibility: { lossy: false, unsupported: [] },
    });
  });

  it("Desktop 兼容形态：委托 DocumentOpenCapable → editable / read-write", async () => {
    const service = await makeDesktopService("# 标题\n\n普通段落");
    const opened = await service.openDocument("01JABC");
    expect(opened?.access).toBe("editable");
    expect(opened?.writePolicy).toEqual({ mode: "read-write" });
    expect(opened?.compatibility).toEqual({ lossy: false, unsupported: [] });
    expect(opened?.source).toMatchObject({
      relativePath: "React.md",
      versionToken: `sha256:${"b".repeat(64)}`,
      modifiedAt: 1722580000000,
      sizeBytes: 64,
    });
  });

  it("Desktop 不支持形态：read-only / lossy-source + unsupported 明细", async () => {
    const service = await makeDesktopService(
      '[[Wiki Link]]\n\n<div class="custom">\nHTML\n</div>',
    );
    const opened = await service.openDocument("01JABC");
    expect(opened?.access).toBe("read-only");
    expect(opened?.writePolicy).toEqual({
      mode: "confirmation-required",
      reason: "lossy-source",
    });
    expect(opened?.compatibility.lossy).toBe(true);
    expect(opened?.compatibility.unsupported.map((f) => f.kind)).toContain(
      "wiki-link",
    );
  });
});
