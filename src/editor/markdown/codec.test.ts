/**
 * MarkdownCodec golden tests（R005 阶段 4，批次 4A）。
 *
 * 覆盖 r005.md §九测试类型清单中本批范围：
 * - parse fixture（metadata/links/assets/unsupported/lineEnding 结构化断言）；
 * - serialize fixture（结构化断言）；
 * - parse → serialize → parse 语义等价（支持子集：标题/列表/表格/任务/
 *   代码块/数学/Frontmatter）；
 * - Frontmatter 未知字段往返保留；
 * - CRLF/LF 策略；
 * - 不支持语法（raw HTML / Wiki 链接 / 脚注）不静默删除。
 * 图片与附件的二进制写回（images/attachments 序列化集成）属批次 4B。
 */
import { describe, expect, it } from "vitest";
import { jsonToText } from "../markdown";
import { createMarkdownCodec } from "./codec";
import type { MarkdownAssetResolver } from "./types";
import attachmentsMd from "./__fixtures__/attachments.md?raw";
import codeBlockMd from "./__fixtures__/code-block.md?raw";
import frontmatterMd from "./__fixtures__/frontmatter.md?raw";
import headingsMd from "./__fixtures__/headings.md?raw";
import imagesMd from "./__fixtures__/images.md?raw";
import markdownLinksMd from "./__fixtures__/markdown-links.md?raw";
import mathematicsMd from "./__fixtures__/mathematics.md?raw";
import nestedListsMd from "./__fixtures__/nested-lists.md?raw";
import rawHtmlMd from "./__fixtures__/raw-html.md?raw";
import tablesMd from "./__fixtures__/tables.md?raw";
import taskListMd from "./__fixtures__/task-list.md?raw";
import unsupportedSyntaxMd from "./__fixtures__/unsupported-syntax.md?raw";
import wikiLinksMd from "./__fixtures__/wiki-links.md?raw";

interface DocNode {
  type: string;
  content?: DocNode[];
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

function topTypes(doc: unknown): string[] {
  return ((doc as DocNode).content ?? []).map((node) => node.type);
}

/** 测试用资源路径解析器：统一生成 `../assets/<name>`。 */
const testResolver: MarkdownAssetResolver = {
  resolveAssetPath: ({ name }) => `../assets/${name}`,
};

const codec = createMarkdownCodec();

describe("parse fixtures", () => {
  it("frontmatter.md：已知字段 typed 解析 + 未知字段原始行保留", async () => {
    const note = await codec.parse({ markdown: frontmatterMd });
    expect(note.metadata).toEqual({
      id: "01JEXAMPLE0000000000000000",
      title: "React Fiber 笔记",
      tags: ["React", "前端"],
      createdAt: "2026-07-28T10:00:00+08:00",
      updatedAt: "2026-07-28T11:00:00+08:00",
      aliases: ["Fiber", "协调器"],
      extra: [
        { key: "x-custom", rawLines: ["x-custom: 自定义值"] },
        { key: "x-rating", rawLines: ["x-rating: 5"] },
      ],
    });
    expect(topTypes(note.document)).toEqual(["heading", "paragraph"]);
    expect(note.lineEnding).toBe("lf");
    expect(note.unsupported).toEqual([]);
  });

  it("headings.md：六级标题", async () => {
    const note = await codec.parse({ markdown: headingsMd });
    const headings = (note.document as DocNode).content!.filter(
      (node) => node.type === "heading",
    );
    expect(headings.map((node) => node.attrs!.level)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it("nested-lists.md：无序/有序列表嵌套层级", async () => {
    const note = await codec.parse({ markdown: nestedListsMd });
    expect(topTypes(note.document)).toEqual([
      "heading",
      "bulletList",
      "orderedList",
    ]);
    const bullet = (note.document as DocNode).content![1];
    // 第一层第二级嵌套仍是 bulletList。
    const nested = bullet.content![0].content!.find(
      (node) => node.type === "bulletList",
    );
    expect(nested).toBeDefined();
    // 第三级嵌套存在。
    expect(
      nested!.content![0].content!.some((node) => node.type === "bulletList"),
    ).toBe(true);
  });

  it("tables.md：管道表格", async () => {
    const note = await codec.parse({ markdown: tablesMd });
    expect(topTypes(note.document)).toContain("table");
  });

  it("task-list.md：任务勾选状态与嵌套", async () => {
    const note = await codec.parse({ markdown: taskListMd });
    const taskList = (note.document as DocNode).content!.find(
      (node) => node.type === "taskList",
    )!;
    const items = taskList.content!;
    expect(items[0].attrs!.checked).toBe(false);
    expect(items[1].attrs!.checked).toBe(true);
    const nested = items[2].content!.find((node) => node.type === "taskList")!;
    expect(nested.content!.map((node) => node.attrs!.checked)).toEqual([
      true,
      false,
    ]);
  });

  it("code-block.md：语言 id 与无语言围栏", async () => {
    const note = await codec.parse({ markdown: codeBlockMd });
    const blocks = (note.document as DocNode).content!.filter(
      (node) => node.type === "codeBlock",
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0].attrs!.language).toBe("ts");
    expect(jsonToText(note.document)).toContain("你好，${name}");
  });

  it("mathematics.md：行内与块级公式", async () => {
    const note = await codec.parse({ markdown: mathematicsMd });
    const inline = (note.document as DocNode)
      .content!.find((node) => node.type === "paragraph")!
      .content!.find((node) => node.type === "inlineMath");
    expect(inline!.attrs!.latex).toBe("E=mc^2");
    const block = (note.document as DocNode).content!.find(
      (node) => node.type === "blockMath",
    );
    expect(block!.attrs!.latex).toContain("\\int_a^b");
  });

  it("markdown-links.md：相对链接收集与解析、外部链接不收集", async () => {
    const note = await codec.parse({
      markdown: markdownLinksMd,
      relativePath: "notes/学习/react.md",
    });
    expect(note.links).toEqual([
      {
        type: "markdown",
        target: "../工作/项目%20A.md",
        text: "项目 A",
        resolvedPath: "notes/工作/项目%20A.md",
      },
      {
        type: "markdown",
        target: "../首页.md",
        text: "根目录笔记",
        resolvedPath: "notes/首页.md",
      },
    ]);
    // 指向非 .md 相对文件的链接是附件资源引用，不进入 links。
    expect(note.assets).toEqual([
      {
        type: "attachment",
        target: "../assets/design.pdf",
        name: "设计文档",
        resolvedPath: "notes/assets/design.pdf",
      },
    ]);
  });

  it("wiki-links.md：target/anchor 分离 + unsupported 标记 + 文本不吞掉", async () => {
    const note = await codec.parse({ markdown: wikiLinksMd });
    expect(note.links).toEqual([
      { type: "wiki", target: "目标页面", text: undefined, anchor: undefined },
      { type: "wiki", target: "目标页面", text: undefined, anchor: "具体小节" },
      { type: "wiki", target: "另一页面", text: "显示文本", anchor: undefined },
    ]);
    expect(
      note.unsupported.filter((entry) => entry.kind === "wiki-link"),
    ).toHaveLength(3);
    // Wiki 链接作为 inline 文本保留在文档中（不得静默吞掉）。
    expect(jsonToText(note.document)).toContain("[[目标页面#具体小节]]");
  });

  it("images.md：相对图片进入 assets，外部图片不收集", async () => {
    const note = await codec.parse({
      markdown: imagesMd,
      relativePath: "notes/学习/react.md",
    });
    expect(note.assets).toEqual([
      {
        type: "image",
        target: "../assets/architecture.png",
        name: "架构图",
        resolvedPath: "notes/assets/architecture.png",
      },
    ]);
  });

  it("attachments.md：附件文件链接进入 assets", async () => {
    const note = await codec.parse({
      markdown: attachmentsMd,
      relativePath: "notes/工作/项目 a.md",
    });
    expect(note.assets.map((asset) => asset.type)).toEqual([
      "attachment",
      "attachment",
    ]);
    expect(note.assets[1].resolvedPath).toBe("notes/assets/data.csv");
  });

  it("raw-html.md：raw HTML 进入 unsupported，可见文本不静默删除", async () => {
    const note = await codec.parse({ markdown: rawHtmlMd });
    const kinds = note.unsupported.map((entry) => entry.kind);
    expect(kinds).toContain("raw-html");
    // 受支持的 inline 标签（u/mark）不报 raw-html，且映射为 mark。
    expect(note.unsupported.map((entry) => entry.snippet)).not.toContain("<u>");
    const text = jsonToText(note.document);
    expect(text).toContain("自定义块内容");
    expect(text).toContain("折叠内容");
    expect(text).toContain("下划线");
    const paragraph = (note.document as DocNode)
      .content!.filter((node) => node.type === "paragraph")
      .find((node) => jsonToText(node).includes("下划线"))!;
    expect(
      paragraph.content!.some((node) =>
        node.marks?.some((mark) => mark.type === "underline"),
      ),
    ).toBe(true);
  });

  it("unsupported-syntax.md：脚注与 Wiki 标记 unsupported，文本保留", async () => {
    const note = await codec.parse({ markdown: unsupportedSyntaxMd });
    const kinds = note.unsupported.map((entry) => entry.kind);
    expect(kinds).toContain("footnote");
    expect(kinds).toContain("wiki-link");
    expect(kinds).toContain("raw-html");
    const text = jsonToText(note.document);
    expect(text).toContain("脚注引用[^1]");
    expect(text).toContain("[[某页面]]");
  });

  it("CRLF 输入检测为 crlf 且正常解析", async () => {
    const note = await codec.parse({
      markdown: "# 标题\r\n\r\n正文\r\n",
    });
    expect(note.lineEnding).toBe("crlf");
    expect(topTypes(note.document)).toEqual(["heading", "paragraph"]);
  });

  it("围栏代码块内的 [[x]] 与 <div> 不误报", async () => {
    const note = await codec.parse({
      markdown: "```\n[[不是链接]] <div>不是HTML</div>\n```",
    });
    expect(note.unsupported).toEqual([]);
  });
});

describe("serialize", () => {
  it("portable 模式：Frontmatter + 正文", async () => {
    const result = await codec.serialize({
      document: {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 1 },
            content: [{ type: "text", text: "标题" }],
          },
        ],
      },
      metadata: {
        id: "abc123",
        title: "标题",
        tags: ["React"],
        createdAt: "2026-07-28T10:00:00+08:00",
      },
      assetResolver: testResolver,
      mode: "portable",
    });
    expect(result.lossy).toBe(false);
    expect(result.markdown).toBe(
      [
        "---",
        "id: abc123",
        "title: 标题",
        "tags: [React]",
        "created: 2026-07-28T10:00:00+08:00",
        "---",
        "",
        "# 标题",
      ].join("\n"),
    );
  });

  it("plain 模式无 metadata 时不含 Frontmatter", async () => {
    const result = await codec.serialize({
      document: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "正文" }] },
        ],
      },
      metadata: {},
      assetResolver: testResolver,
      mode: "plain",
    });
    expect(result.markdown).toBe("正文");
  });

  it("portable 模式：localImage/attachment 序列化为相对资源引用", async () => {
    const result = await codec.serialize({
      document: {
        type: "doc",
        content: [
          { type: "localImage", attrs: { attachmentId: "a1", alt: "架构图" } },
          {
            type: "attachment",
            attrs: { attachmentId: "a2", name: "设计.pdf" },
          },
        ],
      },
      metadata: {},
      assetResolver: testResolver,
      mode: "portable",
    });
    expect(result.markdown).toContain("![架构图](../assets/架构图)");
    expect(result.markdown).toContain("[设计.pdf](../assets/设计.pdf)");
    expect(result.lossy).toBe(false);
  });

  it("plain 模式：localImage/attachment 降级为可见占位文本并标记有损", async () => {
    const result = await codec.serialize({
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "前文" }],
          },
          { type: "localImage", attrs: { attachmentId: "a1", alt: "架构图" } },
          {
            type: "attachment",
            attrs: { attachmentId: "a2", name: "设计.pdf" },
          },
        ],
      },
      metadata: {},
      assetResolver: testResolver,
      mode: "plain",
    });
    expect(result.lossy).toBe(true);
    expect(result.unsupported.map((entry) => entry.kind)).toEqual([
      "local-image",
      "attachment",
    ]);
    expect(result.markdown).toContain("前文");
    expect(result.markdown).toContain("（图片：架构图）");
    expect(result.markdown).toContain("（附件：设计.pdf）");
  });

  it("mention：resolveMentionPath 命中时写标准相对链接，否则降级纯文本", async () => {
    const mentionDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "见 " },
            { type: "mention", attrs: { id: "p1", label: "页面A" } },
          ],
        },
      ],
    };
    const resolved = await codec.serialize({
      document: mentionDoc,
      metadata: {},
      assetResolver: testResolver,
      mode: "portable",
      resolveMentionPath: (pageId) =>
        pageId === "p1" ? "../工作/页面A.md" : null,
    });
    expect(resolved.markdown).toContain("[页面A](../工作/页面A.md)");
    expect(resolved.lossy).toBe(false);

    const degraded = await codec.serialize({
      document: mentionDoc,
      metadata: {},
      assetResolver: testResolver,
      mode: "portable",
    });
    expect(degraded.markdown).toContain("@页面A");
    expect(degraded.lossy).toBe(true);
    expect(degraded.unsupported[0].kind).toBe("mention");
  });

  it("样式与块级属性：textStyle/上下标/对齐/缩进标记有损但正文保留", async () => {
    const result = await codec.serialize({
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { textAlign: "center", indent: 2 },
            content: [
              {
                type: "text",
                marks: [{ type: "textStyle", attrs: { color: "#ff0000" } }],
                text: "红色",
              },
              { type: "text", marks: [{ type: "subscript" }], text: "下标" },
            ],
          },
        ],
      },
      metadata: {},
      assetResolver: testResolver,
      mode: "portable",
    });
    expect(result.lossy).toBe(true);
    expect(result.unsupported.map((entry) => entry.kind)).toEqual([
      "text-align",
      "indent",
      "text-style",
      "subscript",
    ]);
    expect(result.markdown).toContain("红色");
    expect(result.markdown).toContain("下标");
  });

  it("data: Base64 图片降级为占位文本并标记有损", async () => {
    const result = await codec.serialize({
      document: {
        type: "doc",
        content: [
          {
            type: "image",
            attrs: { src: "data:image/png;base64,AAAA", alt: "旧图" },
          },
        ],
      },
      metadata: {},
      assetResolver: testResolver,
      mode: "portable",
    });
    expect(result.lossy).toBe(true);
    expect(result.unsupported[0].kind).toBe("image-data-uri");
    expect(result.markdown).toContain("（图片：旧图）");
    expect(result.markdown).not.toContain("data:image");
  });

  it("换行符策略：默认 LF，可跟随 crlf", async () => {
    const document = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "标题" }],
        },
        { type: "paragraph", content: [{ type: "text", text: "正文" }] },
      ],
    };
    const lf = await codec.serialize({
      document,
      metadata: {},
      assetResolver: testResolver,
      mode: "portable",
    });
    expect(lf.markdown).not.toContain("\r");

    const crlf = await codec.serialize({
      document,
      metadata: {},
      assetResolver: testResolver,
      mode: "portable",
      lineEnding: "crlf",
    });
    expect(crlf.markdown).toContain("\r\n");
    expect(crlf.markdown.replace(/\r\n/g, "")).not.toContain("\n");
  });
});

describe("parse → serialize → parse 语义等价", () => {
  const roundtripFixtures = [
    ["frontmatter.md", frontmatterMd],
    ["headings.md", headingsMd],
    ["nested-lists.md", nestedListsMd],
    ["tables.md", tablesMd],
    ["task-list.md", taskListMd],
    ["code-block.md", codeBlockMd],
    ["mathematics.md", mathematicsMd],
  ] as const;

  it.each(roundtripFixtures)(
    "%s：文档 JSON 与元数据等价",
    async (_, source) => {
      const first = await codec.parse({ markdown: source });
      const serialized = await codec.serialize({
        document: first.document,
        metadata: first.metadata,
        assetResolver: testResolver,
        mode: "portable",
      });
      expect(serialized.lossy).toBe(false);
      const second = await codec.parse({ markdown: serialized.markdown });
      expect(second.document).toEqual(first.document);
      expect(second.metadata).toEqual(first.metadata);
      expect(second.unsupported).toEqual([]);
    },
  );

  it("CRLF 输入跟随换行符往返仍语义等价", async () => {
    const source = `# 标题\r\n\r\n- 项目一\r\n- 项目二\r\n`;
    const first = await codec.parse({ markdown: source });
    expect(first.lineEnding).toBe("crlf");
    const serialized = await codec.serialize({
      document: first.document,
      metadata: first.metadata,
      assetResolver: testResolver,
      mode: "portable",
      lineEnding: first.lineEnding,
    });
    expect(serialized.markdown).toContain("\r\n");
    const second = await codec.parse({ markdown: serialized.markdown });
    expect(second.document).toEqual(first.document);
  });
});

describe("Frontmatter 未知字段往返", () => {
  it("parse → serialize 原样写回且相对顺序不变", async () => {
    const first = await codec.parse({ markdown: frontmatterMd });
    const serialized = await codec.serialize({
      document: first.document,
      metadata: first.metadata,
      assetResolver: testResolver,
      mode: "portable",
    });
    const customIndex = serialized.markdown.indexOf("x-custom: 自定义值");
    const ratingIndex = serialized.markdown.indexOf("x-rating: 5");
    expect(customIndex).toBeGreaterThan(-1);
    expect(ratingIndex).toBeGreaterThan(customIndex);
    // 再次解析：未知字段内容完全一致。
    const second = await codec.parse({ markdown: serialized.markdown });
    expect(second.metadata.extra).toEqual(first.metadata.extra);
  });
});
