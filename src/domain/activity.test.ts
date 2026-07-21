import { describe, expect, it } from "vitest";
import type { DocumentContent, Page, Workspace } from "./types";
import {
  belongingPath,
  buildActivityRows,
  favoritePages,
  favoriteWorkspaces,
  formatRelativeTime,
  workspaceDocStats,
} from "./activity";

function makePage(partial: Partial<Page> & { id: string }): Page {
  return {
    workspaceId: "ws1",
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

function makeWorkspace(partial: Partial<Workspace> & { id: string }): Workspace {
  return {
    name: partial.id,
    icon: null,
    description: "",
    homePageId: null,
    favoriteAt: null,
    lastOpenedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

describe("belongingPath", () => {
  it("拼接知识库与祖先分组链", () => {
    const group = makePage({ id: "g", kind: "group", title: "产品" });
    const sub = makePage({ id: "s", kind: "group", title: "发布会", parentId: "g" });
    const doc = makePage({ id: "d", parentId: "s" });
    const byId = new Map([group, sub, doc].map((p) => [p.id, p]));
    expect(belongingPath(doc, byId, "我的知识库")).toBe("我的知识库 / 产品 / 发布会");
    expect(belongingPath(makePage({ id: "root" }), byId, "我的知识库")).toBe("我的知识库");
  });

  it("父级缺失或成环时安全截断", () => {
    const orphan = makePage({ id: "o", parentId: "missing" });
    const byId = new Map([[orphan.id, orphan]]);
    expect(belongingPath(orphan, byId, "库")).toBe("库");

    const a = makePage({ id: "a", kind: "group", parentId: "b" });
    const b = makePage({ id: "b", kind: "group", parentId: "a" });
    const cyclic = new Map([a, b].map((p) => [p.id, p]));
    expect(() => belongingPath(a, cyclic, "库")).not.toThrow();
  });
});

describe("buildActivityRows", () => {
  const workspaces = [makeWorkspace({ id: "ws1", name: "库一" }), makeWorkspace({ id: "ws2", name: "库二" })];
  const pages = [
    makePage({ id: "a", title: "A", updatedAt: 300, lastOpenedAt: 10 }),
    makePage({ id: "b", title: "B", updatedAt: 100, lastOpenedAt: 50, workspaceId: "ws2" }),
    makePage({ id: "c", title: "C", updatedAt: 200 }),
    makePage({ id: "g", kind: "group", title: "分组", updatedAt: 999 }),
    makePage({ id: "t", title: "回收站", updatedAt: 999, deletedAt: 1 }),
  ];

  it("编辑过按 updatedAt 倒序，排除分组与回收站", () => {
    const rows = buildActivityRows({ pages, workspaces, tab: "edited" });
    expect(rows.map((r) => r.page.id)).toEqual(["a", "c", "b"]);
    expect(rows[0].workspaceName).toBe("库一");
  });

  it("浏览过按 lastOpenedAt 倒序，无浏览时间的不展示", () => {
    const rows = buildActivityRows({ pages, workspaces, tab: "viewed" });
    expect(rows.map((r) => r.page.id)).toEqual(["b", "a"]);
  });

  it("按知识库筛选", () => {
    const rows = buildActivityRows({ pages, workspaces, tab: "edited", workspaceId: "ws2" });
    expect(rows.map((r) => r.page.id)).toEqual(["b"]);
    expect(rows[0].path).toBe("库二");
  });
});

describe("formatRelativeTime", () => {
  const now = 1_700_000_000_000;
  it("按间隔输出中文相对时间", () => {
    expect(formatRelativeTime(now, now - 5_000)).toBe("刚刚");
    expect(formatRelativeTime(now, now - 5 * 60_000)).toBe("5 分钟前");
    expect(formatRelativeTime(now, now - 3 * 3_600_000)).toBe("3 小时前");
    expect(formatRelativeTime(now, now - 2 * 86_400_000)).toBe("2 天前");
    const date = new Date(now - 10 * 86_400_000);
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    expect(formatRelativeTime(now, now - 10 * 86_400_000)).toBe(
      `${date.getFullYear()}-${mm}-${dd}`,
    );
  });
});

describe("workspaceDocStats", () => {
  it("统计文档数（不含分组与回收站）与正文总字数", () => {
    const pages = [
      makePage({ id: "a" }),
      makePage({ id: "b" }),
      makePage({ id: "g", kind: "group" }),
      makePage({ id: "t", deletedAt: 1 }),
      makePage({ id: "x", workspaceId: "ws2" }),
    ];
    const contents: DocumentContent[] = [
      { pageId: "a", contentJson: null, textSnapshot: "一二三四五", updatedAt: 0 },
      { pageId: "b", contentJson: null, textSnapshot: "abc", updatedAt: 0 },
      { pageId: "t", contentJson: null, textSnapshot: "已删除", updatedAt: 0 },
    ];
    expect(workspaceDocStats(pages, contents, "ws1")).toEqual({
      docCount: 2,
      totalChars: 8,
    });
  });
});

describe("收藏排序", () => {
  it("favoriteWorkspaces 按收藏时间倒序", () => {
    const workspaces = [
      makeWorkspace({ id: "a", favoriteAt: 100 }),
      makeWorkspace({ id: "b", favoriteAt: null }),
      makeWorkspace({ id: "c", favoriteAt: 300 }),
      makeWorkspace({ id: "d", favoriteAt: 200 }),
    ];
    expect(favoriteWorkspaces(workspaces).map((w) => w.id)).toEqual(["c", "d", "a"]);
  });

  it("favoritePages 排除分组、回收站与未收藏，按时间倒序", () => {
    const pages = [
      makePage({ id: "a", favoriteAt: 100 }),
      makePage({ id: "b", favoriteAt: 200, deletedAt: 1 }),
      makePage({ id: "c", kind: "group", favoriteAt: 300 }),
      makePage({ id: "d", favoriteAt: null }),
      makePage({ id: "e", favoriteAt: 400 }),
    ];
    expect(favoritePages(pages).map((p) => p.id)).toEqual(["e", "a"]);
  });
});
