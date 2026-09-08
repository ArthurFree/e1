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

  it("CRLF：偏移相对原串（slice 校验）", () => {
    const md =
      "---\r\nid: 1\r\n---\r\n\r\n见 [乙](乙.md) 与 ![图](assets/x.png)\r\n";
    const spans = scanMarkdownLinkDestinations(md);
    expect(spans).toHaveLength(2);
    expect(md.slice(spans[0]!.destinationStart, spans[0]!.destinationEnd)).toBe(
      "乙.md",
    );
    expect(md.slice(spans[1]!.destinationStart, spans[1]!.destinationEnd)).toBe(
      "assets/x.png",
    );
  });

  it("BOM + CRLF：Frontmatter 区域跳过，BOM 计入前缀", () => {
    const md =
      "\uFEFF---\r\nid: 1\r\nx: [伪](a.md)\r\n---\r\n\r\n[乙](乙.md)\r\n";
    const spans = scanMarkdownLinkDestinations(md);
    expect(spans).toHaveLength(1);
    expect(md.slice(spans[0]!.destinationStart, spans[0]!.destinationEnd)).toBe(
      "乙.md",
    );
  });
});

describe("rewriteMarkdownLinkDestinations", () => {
  it("只改目的地，保留 label / Frontmatter / fragment", () => {
    const md = "---\nid: 01\ntitle: 甲\n---\n\n链接 [显示](React.md#节) 不变\n";
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

/**
 * R011.1 C2 byte-equal 断言：after 与 before 只允许在各 destination 区间
 *（含 angle 包裹符 `<>`）内不同，区间之外逐字节相等。
 */
function expectOnlyDestinationsChanged(before: string, after: string): void {
  const spansBefore = scanMarkdownLinkDestinations(before);
  const spansAfter = scanMarkdownLinkDestinations(after);
  expect(spansAfter).toHaveLength(spansBefore.length);
  let beforeCursor = 0;
  let afterCursor = 0;
  for (let i = 0; i < spansBefore.length; i++) {
    const spanBefore = spansBefore[i]!;
    const spanAfter = spansAfter[i]!;
    const beforeStart =
      spanBefore.wrapper === "angle"
        ? spanBefore.destinationStart - 1
        : spanBefore.destinationStart;
    const beforeEnd =
      spanBefore.wrapper === "angle"
        ? spanBefore.destinationEnd + 1
        : spanBefore.destinationEnd;
    const afterStart =
      spanAfter.wrapper === "angle"
        ? spanAfter.destinationStart - 1
        : spanAfter.destinationStart;
    const afterEnd =
      spanAfter.wrapper === "angle"
        ? spanAfter.destinationEnd + 1
        : spanAfter.destinationEnd;
    expect(after.slice(afterCursor, afterStart)).toBe(
      before.slice(beforeCursor, beforeStart),
    );
    beforeCursor = beforeEnd;
    afterCursor = afterEnd;
  }
  expect(after.slice(afterCursor)).toBe(before.slice(beforeCursor));
}

describe("rewriteMarkdownLinkDestinations（R011.1 C2：source-preserving）", () => {
  it("CRLF：输出仍 CRLF，未命中区域逐字节相等", () => {
    const md =
      "---\r\nid: 01\r\n---\r\n\r\n见 [乙](旧/乙.md) 与 [丙](丙.md)\r\n";
    const { markdown, rewrittenCount } = rewriteMarkdownLinkDestinations(md, [
      { oldHref: "旧/乙.md", newHref: "新/乙.md" },
    ]);
    expect(rewrittenCount).toBe(1);
    expect(markdown).toBe(
      "---\r\nid: 01\r\n---\r\n\r\n见 [乙](新/乙.md) 与 [丙](丙.md)\r\n",
    );
    // 无孤立 \n：全部换行仍是 \r\n。
    expect(markdown.replaceAll("\r\n", "")).not.toContain("\n");
    expectOnlyDestinationsChanged(md, markdown);
  });

  it("BOM + LF：BOM 原样保留，Frontmatter 区域不改写", () => {
    const md =
      "\uFEFF---\nid: 01\ntitle: [伪](旧/乙.md)\n---\n\n正文 [乙](旧/乙.md)\n";
    const { markdown, rewrittenCount } = rewriteMarkdownLinkDestinations(md, [
      { oldHref: "旧/乙.md", newHref: "新/乙.md" },
    ]);
    expect(rewrittenCount).toBe(1);
    expect(markdown).toBe(
      "\uFEFF---\nid: 01\ntitle: [伪](旧/乙.md)\n---\n\n正文 [乙](新/乙.md)\n",
    );
    expect(markdown.startsWith("\uFEFF")).toBe(true);
    expectOnlyDestinationsChanged(md, markdown);
  });

  it("BOM + CRLF 组合：BOM 与 \\r\\n 均不变", () => {
    const md = "\uFEFF---\r\nid: 01\r\n---\r\n\r\n正文 [乙](乙.md)\r\n";
    const { markdown, rewrittenCount } = rewriteMarkdownLinkDestinations(md, [
      { oldHref: "乙.md", newHref: "目录/乙.md" },
    ]);
    expect(rewrittenCount).toBe(1);
    expect(markdown).toBe(
      "\uFEFF---\r\nid: 01\r\n---\r\n\r\n正文 [乙](目录/乙.md)\r\n",
    );
    expect(markdown.startsWith("\uFEFF")).toBe(true);
    expect(markdown.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("LF：未命中区域逐字节相等（回归）", () => {
    const md = "# 标题\n\n[a](乙.md) 与 [b](丙.md)\n\n![图](assets/x.png)\n";
    const { markdown, rewrittenCount } = rewriteMarkdownLinkDestinations(md, [
      { oldHref: "乙.md", newHref: "新/乙.md" },
      { oldHref: "assets/x.png", newHref: "assets/y.png" },
    ]);
    expect(rewrittenCount).toBe(2);
    expect(markdown).toBe(
      "# 标题\n\n[a](新/乙.md) 与 [b](丙.md)\n\n![图](assets/y.png)\n",
    );
    expectOnlyDestinationsChanged(md, markdown);
  });

  it("中文路径与含空格路径：空格路径升级为 angle", () => {
    const md = "[文档](目录/笔记.md)\n[空格](old.md)\n";
    const { markdown, rewrittenCount } = rewriteMarkdownLinkDestinations(md, [
      { oldHref: "目录/笔记.md", newHref: "新目录/笔记.md" },
      { oldHref: "old.md", newHref: "new dir/old.md" },
    ]);
    expect(rewrittenCount).toBe(2);
    expect(markdown).toBe("[文档](新目录/笔记.md)\n[空格](<new dir/old.md>)\n");
    expectOnlyDestinationsChanged(md, markdown);
  });

  it("angle 输入保持 angle（含新路径不再含空格时）", () => {
    const md = "[图](<my note.png>) 与 [文](<目录/笔 记.md>)\n";
    const { markdown, rewrittenCount } = rewriteMarkdownLinkDestinations(md, [
      { oldHref: "my note.png", newHref: "assets/my note.png" },
      { oldHref: "目录/笔 记.md", newHref: "目录/笔记.md" },
    ]);
    expect(rewrittenCount).toBe(2);
    expect(markdown).toBe(
      "[图](<assets/my note.png>) 与 [文](<目录/笔记.md>)\n",
    );
    expectOnlyDestinationsChanged(md, markdown);
  });

  it("fragment 与 link title 保留", () => {
    const md = '[节](a/b.md#标题) 与 [题](a/b.md "题注")\n';
    const { markdown, rewrittenCount } = rewriteMarkdownLinkDestinations(md, [
      { oldHref: "a/b.md", newHref: "c/b.md" },
    ]);
    expect(rewrittenCount).toBe(2);
    expect(markdown).toBe('[节](c/b.md#标题) 与 [题](c/b.md "题注")\n');
    expectOnlyDestinationsChanged(md, markdown);
  });

  it("同一行多个链接只改命中的", () => {
    const md = "[a](乙.md) [b](丙.md) [c](乙.md)\n";
    const { markdown, rewrittenCount } = rewriteMarkdownLinkDestinations(md, [
      { oldHref: "乙.md", newHref: "新/乙.md" },
    ]);
    expect(rewrittenCount).toBe(2);
    expect(markdown).toBe("[a](新/乙.md) [b](丙.md) [c](新/乙.md)\n");
    expectOnlyDestinationsChanged(md, markdown);
  });

  it("CRLF 下 code fence 与 inline code 内同名路径不改写", () => {
    const md = "```\r\n[码](乙.md)\r\n```\r\n`[内](乙.md)` [真](乙.md)\r\n";
    const { markdown, rewrittenCount } = rewriteMarkdownLinkDestinations(md, [
      { oldHref: "乙.md", newHref: "新/乙.md" },
    ]);
    expect(rewrittenCount).toBe(1);
    expect(markdown).toBe(
      "```\r\n[码](乙.md)\r\n```\r\n`[内](乙.md)` [真](新/乙.md)\r\n",
    );
    expectOnlyDestinationsChanged(md, markdown);
  });

  it("Frontmatter（含未知字段）原样不动", () => {
    const md =
      "---\r\nid: 01\r\nx-note: 参见 [伪](乙.md)\r\nx-list:\r\n  - 保留\r\n---\r\n\r\n正文 [真](乙.md)\r\n";
    const { markdown, rewrittenCount } = rewriteMarkdownLinkDestinations(md, [
      { oldHref: "乙.md", newHref: "新/乙.md" },
    ]);
    expect(rewrittenCount).toBe(1);
    expect(markdown).toBe(
      "---\r\nid: 01\r\nx-note: 参见 [伪](乙.md)\r\nx-list:\r\n  - 保留\r\n---\r\n\r\n正文 [真](新/乙.md)\r\n",
    );
    expectOnlyDestinationsChanged(md, markdown);
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
    expect(detectUnsupportedLinkSyntax("```\n[[x]]\n```\n`[a][1]`\n")).toEqual(
      [],
    );
  });
});
