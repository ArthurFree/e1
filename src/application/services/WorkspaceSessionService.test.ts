/**
 * WorkspaceSessionService 测试（R005 阶段 6）：会话数据不再携带全部正文——
 * load 只读页面/标签/关联三类数据，类型与运行时双重保证不触碰正文仓储。
 */
import { describe, expect, it, vi } from "vitest";
import { resetDB } from "../../infrastructure/db";
import {
  contentRepository,
  pageRepository,
  tagRepository,
  workspaceRepository,
} from "../../infrastructure/repositories";
import { WorkspaceSessionService } from "./WorkspaceSessionService";

describe("WorkspaceSessionService", () => {
  it("load 返回页面/标签/关联，不含正文且不调用正文仓储", async () => {
    await resetDB();
    const ws = await workspaceRepository.create("知识库");
    const page = await pageRepository.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "文档",
    });
    const tag = await tagRepository.create(ws.id, "标签甲", "#22A06B");
    await tagRepository.setPageTags(page.id, [tag.id]);

    // spy 断言：会话加载不再读取正文（R005 阶段 6；
    // 正文快照由 SearchIndexPort.prepareWorkspace 自行读取）。
    const listByWorkspaceSpy = vi.spyOn(contentRepository, "listByWorkspace");
    const listAllSpy = vi.spyOn(contentRepository, "listAll");

    const session = new WorkspaceSessionService({
      pages: pageRepository,
      tags: tagRepository,
    });
    const data = await session.load(ws.id);

    expect(data.workspaceId).toBe(ws.id);
    expect(data.pages.map((p) => p.id)).toContain(page.id);
    expect(data.tags.map((t) => t.id)).toContain(tag.id);
    expect(data.pageTags).toContainEqual({
      pageId: page.id,
      tagId: tag.id,
      workspaceId: ws.id,
    });
    expect(data).not.toHaveProperty("contents");
    expect(listByWorkspaceSpy).not.toHaveBeenCalled();
    expect(listAllSpy).not.toHaveBeenCalled();
  });
});
