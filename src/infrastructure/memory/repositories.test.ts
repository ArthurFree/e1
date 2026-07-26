/**
 * 内存仓储不变量测试（R003 阶段 5）：与 IndexedDB 实现相同的核心语义——
 * 关系约束错误码、软删/恢复/purge 级联、版本去重、setPageTags 覆盖语义、
 * 偏好合并。两套实现共用这些断言可防止语义漂移。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { isDomainError, type DomainErrorCode } from "../../domain/errors";
import {
  createInMemoryRepositories,
  type MemoryRepositories,
} from "./repositories";

async function expectDomainError(
  promise: Promise<unknown>,
  code: DomainErrorCode,
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(isDomainError(err, code), `期望 ${code}，实际 ${String(err)}`).toBe(true);
    return;
  }
  throw new Error(`期望抛出 ${code}，但操作成功了`);
}

describe("内存仓储", () => {
  let repos: MemoryRepositories;
  let wsId: string;
  let ws2Id: string;

  beforeEach(async () => {
    repos = createInMemoryRepositories();
    wsId = (await repos.workspace.create("甲库")).id;
    ws2Id = (await repos.workspace.create("乙库")).id;
  });

  it("创建的关系约束与 IndexedDB 版一致", async () => {
    const group = await repos.page.create({
      workspaceId: wsId,
      parentId: null,
      kind: "group",
      title: "分组",
    });
    const doc = await repos.page.create({
      workspaceId: wsId,
      parentId: group.id,
      kind: "document",
      title: "文档",
    });
    expect(doc.parentId).toBe(group.id);
    // 不变量：有文档必有 contents 记录。
    expect(await repos.content.get(doc.id)).toBeDefined();

    await expectDomainError(
      repos.page.create({
        workspaceId: "missing",
        parentId: null,
        kind: "document",
        title: "x",
      }),
      "WORKSPACE_NOT_FOUND",
    );
    await expectDomainError(
      repos.page.create({
        workspaceId: wsId,
        parentId: "missing",
        kind: "document",
        title: "x",
      }),
      "PARENT_NOT_FOUND",
    );
    const other = await repos.page.create({
      workspaceId: ws2Id,
      parentId: null,
      kind: "group",
      title: "乙库分组",
    });
    await expectDomainError(
      repos.page.create({
        workspaceId: wsId,
        parentId: other.id,
        kind: "document",
        title: "x",
      }),
      "CROSS_WORKSPACE_PARENT",
    );
    await repos.page.remove(group.id);
    await expectDomainError(
      repos.page.create({
        workspaceId: wsId,
        parentId: group.id,
        kind: "document",
        title: "x",
      }),
      "PARENT_IN_TRASH",
    );
    await expectDomainError(
      repos.page.create({
        workspaceId: wsId,
        parentId: null,
        kind: "document",
        title: "  ",
      }),
      "INVALID_INPUT",
    );
  });

  it("移动约束：环与跨知识库父级", async () => {
    const parent = await repos.page.create({
      workspaceId: wsId,
      parentId: null,
      kind: "group",
      title: "父",
    });
    const child = await repos.page.create({
      workspaceId: wsId,
      parentId: parent.id,
      kind: "group",
      title: "子",
    });
    await expectDomainError(repos.page.move(parent.id, child.id), "PAGE_TREE_CYCLE");
    const other = await repos.page.create({
      workspaceId: ws2Id,
      parentId: null,
      kind: "group",
      title: "乙库分组",
    });
    await expectDomainError(repos.page.move(child.id, other.id), "CROSS_WORKSPACE_PARENT");
  });

  it("软删/恢复/purge 级联", async () => {
    const parent = await repos.page.create({
      workspaceId: wsId,
      parentId: null,
      kind: "group",
      title: "父",
    });
    const child = await repos.page.create({
      workspaceId: wsId,
      parentId: parent.id,
      kind: "document",
      title: "子文档",
    });
    await repos.content.save(child.id, { type: "doc", content: [] }, "正文");
    const tag = await repos.tag.create(wsId, "标签", "#000");
    await repos.tag.setPageTags(child.id, [tag.id]);
    await repos.revision.add(child.id, { type: "doc" }, "正文", "manual");

    // 软删整棵子树。
    await repos.page.remove(parent.id);
    const afterRemove = await repos.page.listByWorkspace(wsId);
    expect(afterRemove.every((p) => p.deletedAt !== null)).toBe(true);

    // 恢复整棵子树：子文档回到原父级。
    await repos.page.restore(parent.id);
    const restored = await repos.page.listByWorkspace(wsId);
    expect(restored.find((p) => p.id === child.id)?.deletedAt).toBeNull();
    expect(restored.find((p) => p.id === child.id)?.parentId).toBe(parent.id);

    // purge 级联：页面/正文/标签关联/版本一并清除。
    await repos.page.remove(parent.id);
    await repos.page.purge(parent.id);
    expect((await repos.page.listByWorkspace(wsId)).length).toBe(0);
    expect(await repos.content.get(child.id)).toBeUndefined();
    expect(await repos.tag.listPageTagIds(child.id)).toEqual([]);
    expect(await repos.revision.listByPage(child.id)).toEqual([]);
  });

  it("版本去重与 interval 清理", async () => {
    const json = { type: "doc", content: [] };
    expect(await repos.revision.add("p1", json, "", "interval")).not.toBeNull();
    // 内容一致不重复创建。
    expect(await repos.revision.add("p1", json, "", "interval")).toBeNull();
    for (let i = 0; i < 3; i++) {
      await repos.revision.add("p1", { type: "doc", content: [{ v: i }] }, `v${i}`, "interval");
    }
    await repos.revision.pruneInterval("p1", 2);
    expect((await repos.revision.listByPage("p1")).filter((r) => r.reason === "interval")).toHaveLength(2);
  });

  it("setPageTags 约束与覆盖语义", async () => {
    const page = await repos.page.create({
      workspaceId: wsId,
      parentId: null,
      kind: "document",
      title: "文档",
    });
    const tagA = await repos.tag.create(wsId, "A", "#000");
    const tagB = await repos.tag.create(wsId, "B", "#111");
    await repos.tag.setPageTags(page.id, [tagA.id, tagB.id]);
    expect((await repos.tag.listPageTagIds(page.id)).sort()).toEqual(
      [tagA.id, tagB.id].sort(),
    );
    // 覆盖：先清后写。
    await repos.tag.setPageTags(page.id, [tagB.id]);
    expect(await repos.tag.listPageTagIds(page.id)).toEqual([tagB.id]);

    const otherTag = await repos.tag.create(ws2Id, "乙库标签", "#222");
    await expectDomainError(
      repos.tag.setPageTags(page.id, [otherTag.id]),
      "CROSS_WORKSPACE_TAG",
    );
    await expectDomainError(
      repos.tag.setPageTags(page.id, ["missing"]),
      "TAG_NOT_FOUND",
    );
    await expectDomainError(
      repos.tag.setPageTags("missing", [tagA.id]),
      "PAGE_NOT_FOUND",
    );
  });

  it("偏好 update 合并", async () => {
    const initial = await repos.preferences.get();
    expect(initial.theme).toBe("light");
    await repos.preferences.update({ theme: "dark" });
    const next = await repos.preferences.update({ sidebarWidth: 300 });
    expect(next.theme).toBe("dark");
    expect(next.sidebarWidth).toBe(300);
  });
});
