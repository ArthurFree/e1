/**
 * R011 Stage 1：Markdown 目的地改写 / relocateHref / 兼容探测测试。
 */
import { describe, expect, it } from "vitest";
import { detectUnsupportedLinkSyntax } from "./detectUnsupportedLinkSyntax.js";
import { relocateHref, applyPathMoves } from "./relocateHref.js";
import { rewriteMarkdownLinkDestinations } from "./rewriteMarkdownLinkDestinations.js";
import { scanMarkdownLinkDestinations } from "./scanMarkdownLinkDestinations.js";

describe("scanMarkdownLinkDestinations", () => {
  it("返回 destination 源码区间（含 Frontmatter 偏移）", () => {
    const md = "---\ntitle: A\n---\n\n见 [乙](乙.md) 与 ![图](assets/x.png)\n";
    const spans = scanMarkdownLinkDestinations(md);
    expect(spans).toHaveLength(2);
    expect(md.slice(spans[0]!.destinationStart, spans[0]!.destinationEnd)).toBe(
      "乙.md",
    );
    expect(md.slice(spans[1]!.destinationStart, spans[1]!.destinationEnd)).toBe(
      "assets/x.png",
    );
    expect(spans[1]!.isImage).toBe(true);
  });

  it("屏蔽围栏与行内代码", () => {
    const md =
      "好 [a](a.md)\n```\n[b](b.md)\n```\n行内 ` [c](c.md) ` 结束 [d](d.md)\n";
    const hrefs = scanMarkdownLinkDestinations(md).map((s) => s.href);
    expect(hrefs).toEqual(["a.md", "d.md"]);
  });
});

describe("rewriteMarkdownLinkDestinations", () => {
  it("只改目的地，保留 label / Frontmatter / fragment", () => {
    const md =
      "---\nid: 01\ntitle: 甲\n---\n\n链接 [显示](React.md#节) 不变\n";
    const { markdown, rewrittenCount } = rewriteMarkdownLinkDestinations(md, [
      { oldHref: "React.md", newHref: "notes/React.md" },
    ]);
    expect(rewrittenCount).toBe(1);
    expect(markdown).toContain("---\nid: 01\ntitle: 甲\n---");
    expect(markdown).toContain("[显示](notes/React.md#节)");
    expect(markdown).not.toContain("(React.md#节)");
  });

  it("空格路径写成 angle；中文与 ../ 可改", () => {
    const md = "![图](<my note.png>)\n[上](../上.md)\n";
    const { markdown } = rewriteMarkdownLinkDestinations(md, [
      { oldHref: "my note.png", newHref: "assets/my note.png" },
      { oldHref: "../上.md", newHref: "上.md" },
    ]);
    expect(markdown).toContain("![图](<assets/my note.png>)");
    expect(markdown).toContain("[上](上.md)");
  });

  it("external / mailto / anchor / 代码不改", () => {
    const md =
      "[外](https://a.com) [邮](mailto:a@b.c) [锚](#x)\n`[内](a.md)`\n```\n[码](a.md)\n```\n[真](a.md)\n";
    const { markdown, rewrittenCount } = rewriteMarkdownLinkDestinations(md, [
      { oldHref: "a.md", newHref: "b.md" },
      { oldHref: "https://a.com", newHref: "https://b.com" },
    ]);
    expect(rewrittenCount).toBe(1);
    expect(markdown).toContain("[外](https://a.com)");
    expect(markdown).toContain("[邮](mailto:a@b.c)");
    expect(markdown).toContain("[锚](#x)");
    expect(markdown).toContain("`[内](a.md)`");
    expect(markdown).toContain("[码](a.md)");
    expect(markdown).toContain("[真](b.md)");
  });

  it("% 编码路径按字面 oldHref 匹配", () => {
    const md = "[x](%E4%B8%99.md)\n";
    const { markdown } = rewriteMarkdownLinkDestinations(md, [
      { oldHref: "%E4%B8%99.md", newHref: "子/丙.md" },
    ]);
    expect(markdown).toContain("[x](子/丙.md)");
  });
});

describe("relocateHref", () => {
  it("目标下移：根→子目录", () => {
    const r = relocateHref({
      sourcePathBefore: "Fiber.md",
      targetPathBefore: "React.md",
      sourcePathAfter: "Fiber.md",
      targetPathAfter: "notes/React.md",
      oldHref: "React.md",
    });
    expect(r.changed).toBe(true);
    expect(r.newHref).toBe("notes/React.md");
  });

  it("源下移：相对路径变 ../", () => {
    const r = relocateHref({
      sourcePathBefore: "Fiber.md",
      targetPathBefore: "React.md",
      sourcePathAfter: "notes/Fiber.md",
      targetPathAfter: "React.md",
      oldHref: "React.md",
    });
    expect(r.changed).toBe(true);
    expect(r.newHref).toBe("../React.md");
  });

  it("source+target 同迁 → skip", () => {
    const r = relocateHref({
      sourcePathBefore: "a/Fiber.md",
      targetPathBefore: "a/React.md",
      sourcePathAfter: "b/Fiber.md",
      targetPathAfter: "b/React.md",
      oldHref: "React.md",
    });
    expect(r.changed).toBe(false);
    expect(r.newHref).toBe("React.md");
  });

  it("保留 fragment；external 不变", () => {
    expect(
      relocateHref({
        sourcePathBefore: "a.md",
        targetPathBefore: "b.md",
        sourcePathAfter: "n/a.md",
        targetPathAfter: "b.md",
        oldHref: "b.md#节",
      }).newHref,
    ).toBe("../b.md#节");
    expect(
      relocateHref({
        sourcePathBefore: "a.md",
        targetPathBefore: "b.md",
        sourcePathAfter: "n/a.md",
        targetPathAfter: "b.md",
        oldHref: "https://x.com",
      }).changed,
    ).toBe(false);
  });

  it("applyPathMoves 支持目录前缀", () => {
    expect(
      applyPathMoves("notes/a.md", [
        { fromRelativePath: "notes", toRelativePath: "学习" },
      ]),
    ).toBe("学习/a.md");
  });
});

describe("detectUnsupportedLinkSyntax", () => {
  it("检出 Wiki 与引用式链接", () => {
    const warnings = detectUnsupportedLinkSyntax(
      "见 [[Wiki]] 与 [a][1]\n\n[1]: https://x.com\n",
    );
    expect(warnings.map((w) => w.code).sort()).toEqual([
      "UNSUPPORTED_REFERENCE_LINK",
      "UNSUPPORTED_WIKI_LINK",
    ]);
  });

  it("代码中的样例不报", () => {
    expect(
      detectUnsupportedLinkSyntax("```\n[[x]]\n```\n`[a][1]`\n"),
    ).toEqual([]);
  });
});
