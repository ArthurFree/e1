import { describe, expect, it } from "vitest";
import type { Page, Workspace } from "./types";
import { buildActivityRows } from "./activity";
import { childrenOf } from "./pageTree";

/**
 * 大数据量性能冒烟（R002 阶段 6）：1000 树节点、500 活动记录下
 * 纯逻辑保持毫秒级。阈值取宽裕值以防 CI 抖动。
 */

function makePage(id: string, parentId: string | null, position: number): Page {
  const now = 1_000_000_000_000;
  return {
    id,
    workspaceId: "w1",
    parentId,
    kind: "document",
    title: `文档 ${id}`,
    icon: null,
    position,
    favoriteAt: null,
    lastOpenedAt: now - position * 1000,
    deletedAt: null,
    createdAt: now,
    updatedAt: now - position * 500,
  };
}

const workspace: Workspace = {
  id: "w1",
  name: "性能库",
  icon: null,
  description: "",
  homePageId: null,
  favoriteAt: null,
  lastOpenedAt: null,
  createdAt: 0,
  updatedAt: 0,
};

describe("大数据量性能冒烟", () => {
  it("1000 个树节点的层级与排序在 500ms 内", () => {
    const pages: Page[] = [];
    for (let i = 0; i < 100; i++) {
      const group: Page = { ...makePage(`g${i}`, null, i), kind: "group" };
      pages.push(group);
      for (let j = 0; j < 9; j++) {
        pages.push(makePage(`g${i}-d${j}`, `g${i}`, j));
      }
    }
    expect(pages).toHaveLength(1000);
    const start = performance.now();
    const roots = childrenOf(pages, null);
    for (const root of roots) childrenOf(pages, root.id);
    expect(performance.now() - start).toBeLessThan(500);
    expect(roots).toHaveLength(100);
  });

  it("500 条活动记录构建在 200ms 内", () => {
    const pages = Array.from({ length: 500 }, (_, i) => makePage(`p${i}`, null, i));
    const start = performance.now();
    const rows = buildActivityRows({ pages, workspaces: [workspace], tab: "edited" });
    expect(performance.now() - start).toBeLessThan(200);
    expect(rows).toHaveLength(500);
  });
});
