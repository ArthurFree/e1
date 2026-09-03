/**
 * rewriteLinkHref 纯函数测试（R010 Stage 6 §14）：
 * 精确匹配整体重写、不可变输入、嵌套结构遍历与命中计数。
 */
import { describe, expect, it } from "vitest";
import { rewriteLinkHref } from "./rewriteLinkHref";

const DOC = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "旧方案",
          marks: [{ type: "link", attrs: { href: "../old/旧方案.md" } }],
        },
        { type: "text", text: "与" },
        {
          type: "text",
          text: "外链",
          marks: [
            { type: "link", attrs: { href: "https://example.com" } },
            { type: "bold" },
          ],
        },
      ],
    },
    {
      type: "blockquote",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "又见旧方案",
              marks: [{ type: "link", attrs: { href: "../old/旧方案.md" } }],
            },
          ],
        },
      ],
    },
  ],
};

describe("rewriteLinkHref", () => {
  it("重写全部 href 精确匹配的 link mark，其余内容不动", () => {
    const { document, rewritten } = rewriteLinkHref(
      DOC,
      "../old/旧方案.md",
      "../archive/新方案.md",
    );
    expect(rewritten).toBe(2);
    const json = JSON.stringify(document);
    expect(json).not.toContain("../old/旧方案.md");
    expect((json.match(/新方案\.md/g) ?? []).length).toBe(2);
    // 其他链接与文本保持不变。
    expect(json).toContain("https://example.com");
    expect(json).toContain("旧方案");
  });

  it("不修改输入（不可变拷贝）", () => {
    const before = JSON.stringify(DOC);
    rewriteLinkHref(DOC, "../old/旧方案.md", "x.md");
    expect(JSON.stringify(DOC)).toBe(before);
  });

  it("无命中时返回原引用且计数为 0", () => {
    const { document, rewritten } = rewriteLinkHref(DOC, "不存在.md", "x.md");
    expect(rewritten).toBe(0);
    expect(document).toBe(DOC);
  });

  it("结构非法输入不抛错、计数为 0", () => {
    expect(rewriteLinkHref(null, "a.md", "b.md").rewritten).toBe(0);
    expect(rewriteLinkHref("文本", "a.md", "b.md").rewritten).toBe(0);
  });
});
