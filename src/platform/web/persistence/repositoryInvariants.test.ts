/**
 * 仓储不变量测试（R003 阶段 4）：页面/标签关系约束与结构化错误码。
 * 断言一律基于 DomainError.code，不解析中文文案。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resetDB } from "./db";
import {
  pageRepository,
  tagRepository,
  workspaceRepository,
} from "./repositories";
import { isDomainError, type DomainErrorCode } from "../../../domain/errors";

/** 断言 promise 以指定领域错误码失败。 */
async function expectDomainError(
  promise: Promise<unknown>,
  code: DomainErrorCode,
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(
      isDomainError(err, code),
      `期望错误码 ${code}，实际抛出 ${String(err)}`,
    ).toBe(true);
    return;
  }
  throw new Error(`期望抛出 ${code}，但操作成功了`);
}

describe("页面关系约束", () => {
  let wsId: string;
  let ws2Id: string;

  beforeEach(async () => {
    await resetDB();
    const [ws] = await workspaceRepository.list();
    wsId = ws.id;
    ws2Id = (await workspaceRepository.create("乙知识库")).id;
  });

  it("合法创建不受影响", async () => {
    const group = await pageRepository.create({
      workspaceId: wsId,
      parentId: null,
      kind: "group",
      title: "分组",
    });
    const doc = await pageRepository.create({
      workspaceId: wsId,
      parentId: group.id,
      kind: "document",
      title: "文档",
    });
    expect(doc.parentId).toBe(group.id);
  });

  it("知识库不存在拒绝创建", async () => {
    await expectDomainError(
      pageRepository.create({
        workspaceId: "missing-ws",
        parentId: null,
        kind: "document",
        title: "文档",
      }),
      "WORKSPACE_NOT_FOUND",
    );
  });

  it("父页面不存在拒绝创建", async () => {
    await expectDomainError(
      pageRepository.create({
        workspaceId: wsId,
        parentId: "missing-parent",
        kind: "document",
        title: "文档",
      }),
      "PARENT_NOT_FOUND",
    );
  });

  it("跨知识库父级拒绝创建", async () => {
    const other = await pageRepository.create({
      workspaceId: ws2Id,
      parentId: null,
      kind: "group",
      title: "乙库分组",
    });
    await expectDomainError(
      pageRepository.create({
        workspaceId: wsId,
        parentId: other.id,
        kind: "document",
        title: "文档",
      }),
      "CROSS_WORKSPACE_PARENT",
    );
  });

  it("回收站中的页面不能作为父级（创建）", async () => {
    const parent = await pageRepository.create({
      workspaceId: wsId,
      parentId: null,
      kind: "group",
      title: "待删分组",
    });
    await pageRepository.remove(parent.id);
    await expectDomainError(
      pageRepository.create({
        workspaceId: wsId,
        parentId: parent.id,
        kind: "document",
        title: "文档",
      }),
      "PARENT_IN_TRASH",
    );
  });

  it("非法 kind 与非法标题拒绝创建", async () => {
    await expectDomainError(
      pageRepository.create({
        workspaceId: wsId,
        parentId: null,
        kind: "folder" as "document",
        title: "文档",
      }),
      "INVALID_INPUT",
    );
    await expectDomainError(
      pageRepository.create({
        workspaceId: wsId,
        parentId: null,
        kind: "document",
        title: "   ",
      }),
      "INVALID_INPUT",
    );
    await expectDomainError(
      pageRepository.create({
        workspaceId: wsId,
        parentId: null,
        kind: "document",
        title: "长".repeat(201),
      }),
      "INVALID_INPUT",
    );
  });

  it("移动到跨知识库父级被拒绝", async () => {
    const page = await pageRepository.create({
      workspaceId: wsId,
      parentId: null,
      kind: "document",
      title: "甲库文档",
    });
    const other = await pageRepository.create({
      workspaceId: ws2Id,
      parentId: null,
      kind: "group",
      title: "乙库分组",
    });
    await expectDomainError(
      pageRepository.move(page.id, other.id),
      "CROSS_WORKSPACE_PARENT",
    );
  });

  it("移动到回收站父级被拒绝", async () => {
    const page = await pageRepository.create({
      workspaceId: wsId,
      parentId: null,
      kind: "document",
      title: "文档",
    });
    const parent = await pageRepository.create({
      workspaceId: wsId,
      parentId: null,
      kind: "group",
      title: "待删分组",
    });
    await pageRepository.remove(parent.id);
    await expectDomainError(
      pageRepository.move(page.id, parent.id),
      "PARENT_IN_TRASH",
    );
  });

  it("移动到不存在的父级被拒绝", async () => {
    const page = await pageRepository.create({
      workspaceId: wsId,
      parentId: null,
      kind: "document",
      title: "文档",
    });
    await expectDomainError(
      pageRepository.move(page.id, "missing-parent"),
      "PARENT_NOT_FOUND",
    );
  });

  it("移动到自身后代形成环被拒绝", async () => {
    const parent = await pageRepository.create({
      workspaceId: wsId,
      parentId: null,
      kind: "group",
      title: "父",
    });
    const child = await pageRepository.create({
      workspaceId: wsId,
      parentId: parent.id,
      kind: "group",
      title: "子",
    });
    await expectDomainError(
      pageRepository.move(parent.id, child.id),
      "PAGE_TREE_CYCLE",
    );
  });
});

describe("标签关系约束", () => {
  let wsId: string;
  let ws2Id: string;

  beforeEach(async () => {
    await resetDB();
    const [ws] = await workspaceRepository.list();
    wsId = ws.id;
    ws2Id = (await workspaceRepository.create("乙知识库")).id;
  });

  it("同知识库正常绑定不受影响", async () => {
    const page = await pageRepository.create({
      workspaceId: wsId,
      parentId: null,
      kind: "document",
      title: "文档",
    });
    const tag = await tagRepository.create(wsId, "标签", "#22A06B");
    await tagRepository.setPageTags(page.id, [tag.id]);
    expect(await tagRepository.listPageTagIds(page.id)).toEqual([tag.id]);
  });

  it("页面不存在拒绝绑定", async () => {
    const tag = await tagRepository.create(wsId, "标签", "#22A06B");
    await expectDomainError(
      tagRepository.setPageTags("missing-page", [tag.id]),
      "PAGE_NOT_FOUND",
    );
  });

  it("标签不存在拒绝绑定", async () => {
    const page = await pageRepository.create({
      workspaceId: wsId,
      parentId: null,
      kind: "document",
      title: "文档",
    });
    await expectDomainError(
      tagRepository.setPageTags(page.id, ["missing-tag"]),
      "TAG_NOT_FOUND",
    );
  });

  it("跨知识库标签拒绝绑定", async () => {
    const page = await pageRepository.create({
      workspaceId: wsId,
      parentId: null,
      kind: "document",
      title: "甲库文档",
    });
    const otherTag = await tagRepository.create(ws2Id, "乙库标签", "#22A06B");
    await expectDomainError(
      tagRepository.setPageTags(page.id, [otherTag.id]),
      "CROSS_WORKSPACE_TAG",
    );
  });
});
