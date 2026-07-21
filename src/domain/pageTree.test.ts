import { describe, expect, it } from "vitest";
import type { Page } from "./types";
import {
  childrenOf,
  collectSubtreeIds,
  dropZoneAt,
  movePage,
  nextPosition,
  resolveDrop,
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
    favoriteAt: null,
    lastOpenedAt: null,
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

describe("dropZoneAt", () => {
  it("上/下 1/4 为前后插入，中间作为子级", () => {
    expect(dropZoneAt(0.1)).toBe("before");
    expect(dropZoneAt(0.5)).toBe("inside");
    expect(dropZoneAt(0.9)).toBe("after");
  });
});

describe("resolveDrop", () => {
  const base = [
    makePage({ id: "a", position: 0 }),
    makePage({ id: "b", position: 1 }),
    makePage({ id: "c", position: 2 }),
    makePage({ id: "f", kind: "group", position: 3 }),
    makePage({ id: "f-child", parentId: "f", position: 0 }),
  ];

  it("before/after 以目标同级位置计算 index", () => {
    expect(resolveDrop(base, "a", "c", "before")).toEqual({
      parentId: null,
      index: 1,
    });
    expect(resolveDrop(base, "a", "c", "after")).toEqual({
      parentId: null,
      index: 2,
    });
  });

  it("inside 放入目标末尾", () => {
    expect(resolveDrop(base, "a", "f", "inside")).toEqual({
      parentId: "f",
      index: 1,
    });
  });

  it("拖到自身或形成环时返回 null", () => {
    expect(resolveDrop(base, "a", "a", "before")).toBeNull();
    expect(resolveDrop(base, "f", "f-child", "inside")).toBeNull();
  });
});

describe("movePage", () => {
  const base = [
    makePage({ id: "a", position: 0 }),
    makePage({ id: "b", position: 1 }),
    makePage({ id: "c", position: 2 }),
    makePage({ id: "f", kind: "group", position: 3 }),
    makePage({ id: "f-child", parentId: "f", position: 0 }),
  ];

  it("同级移动到指定位置并重编 position", () => {
    const result = movePage(base, "a", null, 2);
    expect(childrenOf(result, null).map((p) => p.id)).toEqual([
      "b",
      "c",
      "a",
      "f",
    ]);
    expect(childrenOf(result, null).map((p) => p.position)).toEqual([0, 1, 2, 3]);
  });

  it("index 超出范围时收敛到两端", () => {
    const toEnd = movePage(base, "a", null, 99);
    expect(childrenOf(toEnd, null).at(-1)?.id).toBe("a");
    const toStart = movePage(base, "c", null, -5);
    expect(childrenOf(toStart, null)[0]?.id).toBe("c");
  });

  it("跨父级移动到新父级指定位置", () => {
    const result = movePage(base, "a", "f", 0);
    expect(childrenOf(result, "f").map((p) => p.id)).toEqual(["a", "f-child"]);
    expect(result.find((p) => p.id === "a")?.parentId).toBe("f");
    expect(childrenOf(result, null).map((p) => p.id)).toEqual(["b", "c", "f"]);
  });

  it("移动到自身或后代下抛错", () => {
    expect(() => movePage(base, "f", "f-child", 0)).toThrow(
      "不能移动到自身或其子页面下",
    );
  });

  it("页面不存在抛错", () => {
    expect(() => movePage(base, "missing", null, 0)).toThrow("页面不存在");
  });
});
