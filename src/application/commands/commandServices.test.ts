/**
 * 命令服务双实现测试（R005 批次 1）：WorkspaceCommandService /
 * PageCommandService / DocumentCommandService 的仓储调用、广播事件与
 * 搜索索引同步，用 IndexedDB（fake-indexeddb）与内存两套装配跑同一组断言，
 * 保证两实现语义一致（契约套件模式参照 src/test/documentWriteContract.ts）。
 */
import { describe, expect, it } from "vitest";
import type { AppSyncEvent } from "../../domain/sync";
import type {
  PageRepository,
  WorkspaceRepository,
  ContentRepository,
} from "../../domain/repositories";
import { resetDB } from "../../infrastructure/db";
import {
  contentRepository as idbContent,
  documentWriteRepository as idbDocumentWrite,
  pageRepository as idbPage,
  revisionRepository as idbRevision,
  tagRepository as idbTag,
  workspaceRepository as idbWorkspace,
} from "../../infrastructure/repositories";
import { createInMemoryAppServices } from "../../infrastructure/memory/createInMemoryAppServices";
import { BrowserMemorySearchIndex } from "../../platform/web/search/BrowserMemorySearchIndex";
import { DocumentCommitService } from "../services/DocumentCommitService";
import {
  SyncChannelService,
  type BroadcastChannelLike,
} from "../services/SyncChannelService";
import { WorkspaceSessionService } from "../services/WorkspaceSessionService";
import { WorkspaceCommandService } from "./WorkspaceCommandService";
import { PageCommandService } from "./PageCommandService";
import { TagCommandService } from "./TagCommandService";
import { DocumentCommandService } from "./DocumentCommandService";
import { WorkspaceQueryService } from "../queries/WorkspaceQueryService";

const VALID_DOC = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "初始正文" }] },
  ],
};

/** 捕获广播事件的 mock 频道（信封 {source, event}）。 */
function makeMockChannel() {
  const posted: unknown[] = [];
  const channel: BroadcastChannelLike = {
    onmessage: null,
    postMessage: (message) => {
      posted.push(message);
    },
    close: () => {},
  };
  return { channel, posted };
}

/** 测试上下文：两套装配返回相同形状，供同一组断言复用。 */
interface CommandTestContext {
  commands: {
    workspace: WorkspaceCommandService;
    page: PageCommandService;
    tag: TagCommandService;
    document: DocumentCommandService;
  };
  queries: { workspace: WorkspaceQueryService };
  searchIndex: BrowserMemorySearchIndex;
  repos: {
    workspace: WorkspaceRepository;
    page: PageRepository;
    content: ContentRepository;
  };
  posted: unknown[];
}

/** IndexedDB 装配（fake-indexeddb）：与 browserServices 同结构，手动建实例以便注入 mock 频道。 */
async function makeBrowserContext(): Promise<CommandTestContext> {
  await resetDB();
  const searchIndex = new BrowserMemorySearchIndex({
    pages: idbPage,
    content: idbContent,
  });
  const { channel, posted } = makeMockChannel();
  const syncChannel = new SyncChannelService(channel, "tab-test");
  const session = new WorkspaceSessionService({
    pages: idbPage,
    tags: idbTag,
  });
  const documentCommit = new DocumentCommitService({
    content: idbContent,
    documentWrite: idbDocumentWrite,
    revisions: idbRevision,
    searchIndex,
    syncChannel,
  });
  return {
    commands: {
      workspace: new WorkspaceCommandService({
        workspace: idbWorkspace,
        syncChannel,
      }),
      page: new PageCommandService({
        page: idbPage,
        searchIndex,
        syncChannel,
      }),
      tag: new TagCommandService({ tag: idbTag }),
      document: new DocumentCommandService({ documentCommit, syncChannel }),
    },
    queries: {
      workspace: new WorkspaceQueryService({
        workspace: idbWorkspace,
        page: idbPage,
        tag: idbTag,
        session,
        searchIndex,
      }),
    },
    searchIndex,
    repos: { workspace: idbWorkspace, page: idbPage, content: idbContent },
    posted,
  };
}

/** 内存装配：经 createInMemoryAppServices 注入 mock 频道。 */
function makeMemoryContext(): CommandTestContext {
  const { channel, posted } = makeMockChannel();
  const { services } = createInMemoryAppServices({ syncChannel: channel });
  return {
    commands: services.commands,
    queries: { workspace: services.queries.workspace },
    searchIndex: services.searchIndex,
    repos: {
      workspace: services.workspace,
      page: services.page,
      content: services.content,
    },
    posted,
  };
}

/** 从信封中取出事件列表。 */
function eventsOf(posted: unknown[]): AppSyncEvent[] {
  return posted.map((m) => (m as { event: AppSyncEvent }).event);
}

function describeCommandServices(
  name: string,
  makeContext: () => CommandTestContext | Promise<CommandTestContext>,
): void {
  describe(`命令服务（${name}）`, () => {
    it("workspace.create 落库并广播 workspace-changed", async () => {
      const ctx = await makeContext();
      const ws = await ctx.commands.workspace.create("新知识库", {
        description: "说明",
      });
      const list = await ctx.repos.workspace.list();
      expect(list.some((w) => w.id === ws.id && w.name === "新知识库")).toBe(
        true,
      );
      expect(eventsOf(ctx.posted)).toContainEqual({
        type: "workspace-changed",
        workspaceId: ws.id,
      });
    });

    it("workspace.toggleFavorite / setLastOpened 只写不广播", async () => {
      const ctx = await makeContext();
      const ws = await ctx.repos.workspace.create("知识库");
      ctx.posted.length = 0;
      await ctx.commands.workspace.toggleFavorite(ws.id, 123);
      await ctx.commands.workspace.setLastOpened(ws.id, 456);
      const stored = (await ctx.repos.workspace.list()).find(
        (w) => w.id === ws.id,
      );
      expect(stored?.favoriteAt).toBe(123);
      expect(stored?.lastOpenedAt).toBe(456);
      expect(eventsOf(ctx.posted)).toEqual([]);
    });

    it("page.create 落库并广播 page-changed", async () => {
      const ctx = await makeContext();
      const ws = await ctx.repos.workspace.create("知识库");
      ctx.posted.length = 0;
      const page = await ctx.commands.page.create({
        workspaceId: ws.id,
        parentId: null,
        kind: "document",
        title: "无标题",
      });
      const pages = await ctx.repos.page.listByWorkspace(ws.id);
      expect(pages.map((p) => p.id)).toContain(page.id);
      expect(eventsOf(ctx.posted)).toContainEqual({
        type: "page-changed",
        workspaceId: ws.id,
        pageId: page.id,
      });
    });

    it("page.rename（updatedPage 非空）同步搜索索引并广播", async () => {
      const ctx = await makeContext();
      const ws = await ctx.repos.workspace.create("知识库");
      const page = await ctx.repos.page.create({
        workspaceId: ws.id,
        parentId: null,
        kind: "document",
        title: "旧标题",
      });
      // 经查询服务构建索引（对应 Provider 会话加载路径）。
      await ctx.queries.workspace.loadSession(ws.id);
      ctx.posted.length = 0;

      const now = Date.now();
      await ctx.commands.page.rename(page.id, "新标题", {
        ...page,
        title: "新标题",
        updatedAt: now,
      });
      const stored = (await ctx.repos.page.listByWorkspace(ws.id)).find(
        (p) => p.id === page.id,
      );
      expect(stored?.title).toBe("新标题");
      // 索引立即反映新标题。
      const hits = await ctx.searchIndex.query(ws.id, "新标题");
      expect(hits.map((h) => h.pageId)).toContain(page.id);
      expect(eventsOf(ctx.posted)).toContainEqual({
        type: "page-changed",
        workspaceId: ws.id,
        pageId: page.id,
      });
    });

    it("page.rename（updatedPage 为 null）只落库，不动索引不广播", async () => {
      const ctx = await makeContext();
      const ws = await ctx.repos.workspace.create("知识库");
      const page = await ctx.repos.page.create({
        workspaceId: ws.id,
        parentId: null,
        kind: "document",
        title: "旧标题",
      });
      await ctx.queries.workspace.loadSession(ws.id);
      ctx.posted.length = 0;

      await ctx.commands.page.rename(page.id, "改名绕过索引", null);
      const stored = (await ctx.repos.page.listByWorkspace(ws.id)).find(
        (p) => p.id === page.id,
      );
      expect(stored?.title).toBe("改名绕过索引");
      // 索引仍是旧标题，且无广播。
      expect(await ctx.searchIndex.query(ws.id, "改名绕过索引")).toEqual([]);
      expect(eventsOf(ctx.posted)).toEqual([]);
    });

    it("page.remove 软删除并广播 page-changed", async () => {
      const ctx = await makeContext();
      const ws = await ctx.repos.workspace.create("知识库");
      const page = await ctx.repos.page.create({
        workspaceId: ws.id,
        parentId: null,
        kind: "document",
        title: "待删",
      });
      ctx.posted.length = 0;
      await ctx.commands.page.remove(page.id, ws.id);
      const stored = (await ctx.repos.page.listByWorkspace(ws.id)).find(
        (p) => p.id === page.id,
      );
      expect(stored?.deletedAt).not.toBeNull();
      expect(eventsOf(ctx.posted)).toContainEqual({
        type: "page-changed",
        workspaceId: ws.id,
        pageId: page.id,
      });
    });

    it("page.move 落库并广播 page-changed", async () => {
      const ctx = await makeContext();
      const ws = await ctx.repos.workspace.create("知识库");
      const parent = await ctx.repos.page.create({
        workspaceId: ws.id,
        parentId: null,
        kind: "group",
        title: "分组",
      });
      const child = await ctx.repos.page.create({
        workspaceId: ws.id,
        parentId: null,
        kind: "document",
        title: "子页",
      });
      ctx.posted.length = 0;
      await ctx.commands.page.move(child.id, parent.id, 0, ws.id);
      const stored = (await ctx.repos.page.listByWorkspace(ws.id)).find(
        (p) => p.id === child.id,
      );
      expect(stored?.parentId).toBe(parent.id);
      expect(eventsOf(ctx.posted)).toContainEqual({
        type: "page-changed",
        workspaceId: ws.id,
        pageId: child.id,
      });
    });

    it("page.toggleFavorite / setLastOpened 只写不广播", async () => {
      const ctx = await makeContext();
      const ws = await ctx.repos.workspace.create("知识库");
      const page = await ctx.repos.page.create({
        workspaceId: ws.id,
        parentId: null,
        kind: "document",
        title: "文档",
      });
      ctx.posted.length = 0;
      await ctx.commands.page.toggleFavorite(page.id, 111);
      await ctx.commands.page.setLastOpened(page.id, 222);
      const stored = (await ctx.repos.page.listByWorkspace(ws.id)).find(
        (p) => p.id === page.id,
      );
      expect(stored?.favoriteAt).toBe(111);
      expect(stored?.lastOpenedAt).toBe(222);
      expect(eventsOf(ctx.posted)).toEqual([]);
    });

    it("document.createWithContent 原子创建并广播 page-changed", async () => {
      const ctx = await makeContext();
      const ws = await ctx.repos.workspace.create("知识库");
      ctx.posted.length = 0;
      const page = await ctx.commands.document.createWithContent({
        workspaceId: ws.id,
        parentId: null,
        title: "原子文档",
        contentJson: VALID_DOC,
        textSnapshot: "初始正文",
      });
      const stored = await ctx.repos.content.get(page.id);
      expect(stored?.textSnapshot).toBe("初始正文");
      expect(eventsOf(ctx.posted)).toContainEqual({
        type: "page-changed",
        workspaceId: ws.id,
        pageId: page.id,
      });
    });
  });
}

describeCommandServices("IndexedDB", makeBrowserContext);
describeCommandServices("内存", makeMemoryContext);
