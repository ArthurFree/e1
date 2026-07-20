import { describe, expect, it } from "vitest";
import type { Page } from "./types";
import {
  childrenOf,
  collectSubtreeIds,
  nextPosition,
  wouldCreateCycle,
} from "./pageTree";

function makePage(partial: Partial<Page> & { id: string }): Page {
  return {
    workspaceId: "ws",
    parentId: null,
    kind: "document",
    title: partial.id,
    icon: null,
    position: 0,
    deletedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

describe("childrenOf", () => {
  it("按 position 排序并排除已删除", () => {
    const pages = [
      makePage({ id: "a", position: 2 }),
      makePage({ id: "b", position: 0 }),
      makePage({ id: "c", position: 1, deletedAt: 123 }),
      makePage({ id: "d", position: 1, parentId: "other" }),
    ];
    expect(childrenOf(pages, null).map((p) => p.id)).toEqual(["b", "a"]);
  });
});

describe("nextPosition", () => {
  it("空同级从 0 开始", () => {
    expect(nextPosition([], null)).toBe(0);
  });

  it("追加到同级末尾", () => {
    const pages = [makePage({ id: "a", position: 0 }), makePage({ id: "b", position: 4 })];
    expect(nextPosition(pages, null)).toBe(5);
    expect(nextPosition(pages, "x")).toBe(0);
  });
});

describe("wouldCreateCycle", () => {
  const pages = [
    makePage({ id: "root" }),
    makePage({ id: "child", parentId: "root" }),
    makePage({ id: "grandchild", parentId: "child" }),
  ];

  it("移动到自身是环", () => {
    expect(wouldCreateCycle(pages, "root", "root")).toBe(true);
  });

  it("移动到后代是环", () => {
    expect(wouldCreateCycle(pages, "root", "grandchild")).toBe(true);
  });

  it("移动到根或无关节点不是环", () => {
    expect(wouldCreateCycle(pages, "grandchild", null)).toBe(false);
    expect(wouldCreateCycle(pages, "child", null)).toBe(false);
  });
});

describe("collectSubtreeIds", () => {
  it("包含自身和全部后代", () => {
    const pages = [
      makePage({ id: "root" }),
      makePage({ id: "child", parentId: "root" }),
      makePage({ id: "grandchild", parentId: "child" }),
      makePage({ id: "other" }),
    ];
    expect(collectSubtreeIds(pages, "root").sort()).toEqual([
      "child",
      "grandchild",
      "root",
    ]);
  });
});
