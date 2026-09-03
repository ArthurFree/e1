/**
 * R010 Stage 2：双提取器一致性契约语料。
 *
 * 每条样例同时喂给 MarkdownCodec.parse → extractDocumentLinks（JSON 侧）
 * 与 extractMarkdownLinks（Markdown 源文本侧），契约测试
 * （src/editor/markdown/extractLinksConsistency.test.ts）断言两者输出
 * 完全一致（语料不含 mention/internalLink 节点，两侧 knownTargetPageId
 * 恒为 null）。
 *
 * 语料刻意避开两侧已知不一致的形态（见 extractMarkdownLinks.ts 头注释）：
 * 裸空格目的地、引用式链接、自动链接、Wiki 链接、label 内嵌套方括号、
 * 链接文字内的内联格式（JSON 侧会被切成多个 text 节点，label 不合并）。
 */

/** 一条契约语料：Markdown 原文 + 该文件在 vault 内的相对路径。 */
export interface LinkExtractionFixture {
  name: string;
  markdown: string;
  sourceRelativePath: string;
}

export const LINK_EXTRACTION_FIXTURES: LinkExtractionFixture[] = [
  {
    name: "同级与 ./ 相对链接（中文目录）",
    sourceRelativePath: "目录/页面A.md",
    markdown: [
      "# 页面A",
      "",
      "参见 [页面B](./页面B.md) 与 [页面C](页面C.md)。",
    ].join("\n"),
  },
  {
    name: "../ 上溯链接",
    sourceRelativePath: "项目/子目录/笔记.md",
    markdown: "回到 [说明](../共享/说明.md) 与 [根页](../../README.md)。",
  },
  {
    name: "百分号编码路径（%20 与中文编码）",
    sourceRelativePath: "dir/a.md",
    markdown: [
      "[空格笔记](my%20note.md)",
      "",
      "[中文编码](%E4%B8%AD%E6%96%87.md)",
    ].join("\n"),
  },
  {
    name: "尖括号包裹的空格路径",
    sourceRelativePath: "dir/a.md",
    markdown: "[空格笔记](<my note.md>)",
  },
  {
    name: "fragment 与纯锚点",
    sourceRelativePath: "文档/章节.md",
    markdown: [
      "跳到 [目标页第二节](目标页.md#第二节)，或 [回到顶部](#顶部)。",
    ].join("\n"),
  },
  {
    name: "围栏代码块中的假链接不产出（``` 与 ~~~）",
    sourceRelativePath: "docs/a.md",
    markdown: [
      "真实链接：[真实](real.md)",
      "",
      "```markdown",
      "假链接：[假](fake.md)",
      "![假图](fake.png)",
      "```",
      "",
      "~~~",
      "也是假的：[假的](also-fake.md)",
      "~~~",
      "",
      "围栏后：[真实二](real2.md)",
    ].join("\n"),
  },
  {
    name: "行内代码中的假链接不产出",
    sourceRelativePath: "docs/a.md",
    markdown: "正文 `[行内假链接](inline-fake.md)` 之后是 [真链接](real.md)。",
  },
  {
    name: "图片（相对 asset 与外部 URL）",
    sourceRelativePath: "目录/页面A.md",
    markdown: [
      "![示意图](../assets/示意图.png)",
      "",
      "![外部图](https://cdn.example.com/banner.png)",
    ].join("\n"),
  },
  {
    name: "外部链接、mailto 与绝对路径",
    sourceRelativePath: "docs/a.md",
    markdown: [
      "[官网](https://example.com/docs/x.md) / [协议相对](//cdn.example.com/a.md) /",
      "[邮箱](mailto:a@b.com) / [绝对路径](/abs/path/x.md)",
    ].join("\n"),
  },
  {
    name: "附件链接（相对非 .md 文件）",
    sourceRelativePath: "目录/页面A.md",
    markdown: "[设计稿](../assets/design.pdf)",
  },
  {
    name: "vault 根逃逸（targetRelativePath 为 null 的 broken 形态）",
    sourceRelativePath: "a.md",
    markdown: "[逃逸](../outside.md)",
  },
  {
    name: "Frontmatter 中的链接形态文本不产出",
    sourceRelativePath: "目录/页面A.md",
    markdown: [
      "---",
      "id: page-a",
      'title: "标题里的 [假链接](fake.md)"',
      "---",
      "",
      "正文 [真链接](real.md)。",
    ].join("\n"),
  },
  {
    name: "平衡括号文件名与题注",
    sourceRelativePath: "docs/a.md",
    markdown: [
      "[函数说明](api/fn(1).md)",
      "",
      '[带题注](target.md "题注内容")',
    ].join("\n"),
  },
  {
    name: "标题、列表与引用块中的链接",
    sourceRelativePath: "docs/a.md",
    markdown: [
      "## [标题链接](heading.md)",
      "",
      "- [列表项](list-item.md)",
      "",
      "> [引用链接](quote.md)",
    ].join("\n"),
  },
  {
    name: "CRLF 换行",
    sourceRelativePath: "docs/a.md",
    markdown: "[甲](one.md)\r\n\r\n[乙](two.md)",
  },
];
