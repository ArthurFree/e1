/**
 * R010 Stage 2：extractMarkdownLinks（Markdown 源文本侧）单元测试。
 *
 * 覆盖：Frontmatter 剥离、围栏/行内代码屏蔽、中文/空格/%20/./../fragment、
 * 平衡括号与尖括号目的地、题注忽略、图片、外部/mailto/锚点、
 * vault 根逃逸（targetRelativePath=null）、CRLF、裸空格目的地不产出。
 */
import { describe, expect, it } from "vitest";

import { extractMarkdownLinks } from "./extractMarkdownLinks.js";

describe("extractMarkdownLinks：基础形态", () => {
  it("同级 / ./ / ../ 相对链接归一到 vault 根", () => {
    const links = extractMarkdownLinks(
      "[页面B](./页面B.md) 与 [页面C](页面C.md) 与 [说明](../共享/说明.md)",
      "目录/页面A.md",
    );
    expect(links.map((l) => l.targetRelativePath)).toEqual([
      "目录/页面B.md",
      "目录/页面C.md",
      "共享/说明.md",
    ]);
    expect(links.every((l) => l.kind === "internal")).toBe(true);
    expect(links.every((l) => l.knownTargetPageId === null)).toBe(true);
  });

  it("label 取链接文字，href 保留原文", () => {
    const links = extractMarkdownLinks("[我的笔记](note.md)", "a.md");
    expect(links[0]).toMatchObject({ label: "我的笔记", href: "note.md" });
  });

  it("fragment 剥离与纯锚点", () => {
    const links = extractMarkdownLinks(
      "[章节](目标页.md#第二节) [回顶](#顶部)",
      "文档/章节.md",
    );
    expect(links[0]).toMatchObject({
      kind: "internal",
      fragment: "第二节",
      targetRelativePath: "文档/目标页.md",
    });
    expect(links[1]).toMatchObject({
      kind: "anchor",
      fragment: "顶部",
      targetRelativePath: null,
    });
  });

  it("百分号编码：href 原文保留，targetRelativePath 解码归一", () => {
    const links = extractMarkdownLinks(
      "[编码](my%20note.md) [中文](%E4%B8%AD%E6%96%87.md)",
      "dir/a.md",
    );
    expect(links[0].href).toBe("my%20note.md");
    expect(links[0].targetRelativePath).toBe("dir/my note.md");
    expect(links[1].targetRelativePath).toBe("dir/中文.md");
  });

  it("平衡括号文件名", () => {
    const links = extractMarkdownLinks("[函数](api/fn(1).md)", "docs/a.md");
    expect(links[0]).toMatchObject({
      href: "api/fn(1).md",
      targetRelativePath: "docs/api/fn(1).md",
    });
  });

  it("尖括号包裹的空格路径（剥离尖括号）", () => {
    const links = extractMarkdownLinks("[空格](<my note.md>)", "dir/a.md");
    expect(links[0]).toMatchObject({
      href: "my note.md",
      targetRelativePath: "dir/my note.md",
    });
  });

  it("题注被忽略（双引号与单引号）", () => {
    const links = extractMarkdownLinks(
      "[甲](a.md \"题注\") [乙](b.md '题注')",
      "a.md",
    );
    expect(links.map((l) => l.href)).toEqual(["a.md", "b.md"]);
  });

  it("裸空格目的地不是合法链接（与 marked 一致），不产出", () => {
    expect(extractMarkdownLinks("[笔记](my note.md)", "a.md")).toEqual([]);
  });

  it("外部 / mailto / 绝对路径 / 协议相对", () => {
    const links = extractMarkdownLinks(
      "[官网](https://example.com/x.md) [cdn](//cdn.example.com/a.md) " +
        "[邮箱](mailto:a@b.com) [绝对](/abs/x.md)",
      "a.md",
    );
    expect(links.map((l) => l.kind)).toEqual([
      "external",
      "external",
      "mailto",
      "external",
    ]);
    expect(links.every((l) => l.targetRelativePath === null)).toBe(true);
  });

  it("附件链接与图片 → asset 并归一", () => {
    const links = extractMarkdownLinks(
      "[设计稿](../assets/design.pdf)\n\n![示意图](../assets/示意图.png)",
      "目录/页面A.md",
    );
    expect(links[0]).toMatchObject({
      kind: "asset",
      label: "设计稿",
      targetRelativePath: "assets/design.pdf",
    });
    expect(links[1]).toMatchObject({
      kind: "asset",
      label: "示意图",
      targetRelativePath: "assets/示意图.png",
    });
  });

  it("外部图片 URL → external", () => {
    const links = extractMarkdownLinks(
      "![外部图](https://cdn.example.com/a.png)",
      "a.md",
    );
    expect(links[0]).toMatchObject({ kind: "external", label: "外部图" });
  });

  it("vault 根逃逸 → kind 保持 internal，targetRelativePath 为 null", () => {
    const links = extractMarkdownLinks("[逃逸](../outside.md)", "a.md");
    expect(links[0]).toMatchObject({
      kind: "internal",
      targetRelativePath: null,
    });
    expect(links[0].href).toBe("../outside.md");
  });

  it("空 href 不产出", () => {
    expect(extractMarkdownLinks("[空]()", "a.md")).toEqual([]);
  });

  it("CRLF 换行同样提取", () => {
    const links = extractMarkdownLinks(
      "[甲](one.md)\r\n\r\n[乙](two.md)",
      "a.md",
    );
    expect(links.map((l) => l.href)).toEqual(["one.md", "two.md"]);
  });
});

describe("extractMarkdownLinks：屏蔽规则", () => {
  it("Frontmatter 中的链接形态文本不产出", () => {
    const markdown = [
      "---",
      "id: page-a",
      'title: "标题里的 [假链接](fake.md)"',
      "---",
      "",
      "正文 [真链接](real.md)。",
    ].join("\n");
    const links = extractMarkdownLinks(markdown, "a.md");
    expect(links.map((l) => l.href)).toEqual(["real.md"]);
  });

  it("围栏代码块（``` 与 ~~~）整段屏蔽", () => {
    const markdown = [
      "```markdown",
      "[假](fake.md)",
      "![假图](fake.png)",
      "```",
      "~~~",
      "[也假](also-fake.md)",
      "~~~",
      "[真](real.md)",
    ].join("\n");
    const links = extractMarkdownLinks(markdown, "a.md");
    expect(links.map((l) => l.href)).toEqual(["real.md"]);
  });

  it("行内代码中的链接样例不产出", () => {
    const links = extractMarkdownLinks(
      "正文 `[行内假链接](inline-fake.md)` 之后 [真](real.md)",
      "a.md",
    );
    expect(links.map((l) => l.href)).toEqual(["real.md"]);
  });
});
