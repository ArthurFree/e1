import { describe, expect, it } from "vitest";
import type { DocumentContent, Page } from "./types";
import { searchPages } from "./search";

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

function makeContent(pageId: string, textSnapshot: string): DocumentContent {
  return { pageId, contentJson: null, textSnapshot, updatedAt: 0 };
}

describe("searchPages", () => {
  const pages = [
    makePage({ id: "a", title: "产品路线图" }),
    makePage({ id: "b", title: "会议纪要" }),
    makePage({ id: "c", title: "随手记", deletedAt: 123 }),
    makePage({ id: "d", title: "资料夹", kind: "folder" }),
  ];
  const contents = [
    makeContent("a", "包含季度目标与里程碑"),
    makeContent("b", "讨论了产品发布节奏与产品指标"),
  ];

  it("空查询返回空数组", () => {
    expect(searchPages(pages, contents, "  ")).toEqual([]);
  });

  it("按标题与正文匹配，大小写不敏感", () => {
    const results = searchPages(
      [makePage({ id: "x", title: "Hello World" })],
      [makeContent("x", "")],
      "hello",
    );
    expect(results.map((r) => r.pageId)).toEqual(["x"]);
  });

  it("标题命中排在正文命中之前", () => {
    const results = searchPages(pages, contents, "产品");
    expect(results.map((r) => r.pageId)).toEqual(["a", "b"]);
  });

  it("排除回收站页面", () => {
    expect(searchPages(pages, contents, "随手记")).toEqual([]);
  });

  it("正文命中返回上下文片段", () => {
    const [result] = searchPages(pages, contents, "里程碑");
    expect(result.pageId).toBe("a");
    expect(result.snippet).toContain("里程碑");
  });

  it("仅标题命中时片段为空字符串", () => {
    const [result] = searchPages(pages, contents, "会议纪要");
    expect(result.snippet).toBe("");
  });
});
