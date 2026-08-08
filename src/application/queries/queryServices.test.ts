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
  tagRepository as idbTag,
  workspaceRepository as idbWorkspace,
} from "../../infrastructure/repositories";
import { createInMemoryAppServices } from "../../infrastructure/memory/createInMemoryAppServices";
import { SearchIndexService } from "../services/SearchIndexService";
import { WorkspaceSessionService } from "../services/WorkspaceSessionService";
import { WorkspaceQueryService } from "./WorkspaceQueryService";
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
  searchIndex: SearchIndexService;
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
  const searchIndex = new SearchIndexService();
  const session = new WorkspaceSessionService({
    pages: idbPage,
    tags: idbTag,
    content: idbContent,
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
  // 页面创建时已写入 version 1 的空正文：首次保存 expectedVersion 为 1。
  await ctx.repos.content.save(page.id, DOC_WITH_KEYWORD, "正文关键词甲", 1);
  return { ws, page };
}

function describeQueryServices(
  name: string,
  makeContext: () => QueryTestContext | Promise<QueryTestContext>,
): void {
  describe(`查询服务（${name}）`, () => {
    it("loadSession 返回会话数据并构建搜索索引", async () => {
      const ctx = await makeContext();
      const { ws, page } = await seedKeywordDocument(ctx);
      const data = await ctx.queries.workspace.loadSession(ws.id);
      expect(data.workspaceId).toBe(ws.id);
      expect(data.pages.map((p) => p.id)).toContain(page.id);
      expect(ctx.searchIndex.has(ws.id)).toBe(true);
      const hits = ctx.searchIndex.query(ws.id, "关键词");
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
      const hits = ctx.searchIndex.query(ws.id, "改名后标题");
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
