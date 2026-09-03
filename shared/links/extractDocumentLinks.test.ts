/**
 * R010 Stage 2：extractDocumentLinks（Tiptap JSON 侧）单元测试。
 *
 * 覆盖：link mark 分类与路径归一（中文/空格/%20/./../fragment）、
 * internalLink/mention 页面引用节点、image/attachment src、
 * 代码块样例天然排除、空 href、vault 根逃逸（targetRelativePath=null）。
 */
import { describe, expect, it } from "vitest";

import {
  extractDocumentLinks,
  type ExtractedLink,
} from "./extractDocumentLinks.js";

function textWithLink(text: string, href: string) {
  return { type: "text", text, marks: [{ type: "link", attrs: { href } }] };
}

function doc(...content: unknown[]) {
  return { type: "doc", content };
}

function paragraph(...content: unknown[]) {
  return { type: "paragraph", content };
}

/** 只保留关键字段，便于断言。 */
function simplify(links: ExtractedLink[]) {
  return links.map(
    ({
      href,
      label,
      kind,
      fragment,
      targetRelativePath,
      knownTargetPageId,
    }) => ({
      href,
      label,
      kind,
      fragment,
      targetRelativePath,
      knownTargetPageId,
    }),
  );
}

describe("extractDocumentLinks：link mark", () => {
  it("相对 .md 链接 → internal，并归一到 vault 根", () => {
    const links = extractDocumentLinks(
      doc(paragraph(textWithLink("页面B", "./页面B.md"))),
      "目录/页面A.md",
    );
    expect(simplify(links)).toEqual([
      {
        href: "./页面B.md",
        label: "页面B",
        kind: "internal",
        fragment: null,
        targetRelativePath: "目录/页面B.md",
        knownTargetPageId: null,
      },
    ]);
  });

  it("../ 上溯与嵌套结构（列表/引用块）递归遍历", () => {
    const links = extractDocumentLinks(
      doc({
        type: "blockquote",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [paragraph(textWithLink("说明", "../共享/说明.md"))],
              },
            ],
          },
        ],
      }),
      "项目/子目录/笔记.md",
    );
    expect(links).toHaveLength(1);
    expect(links[0].targetRelativePath).toBe("项目/共享/说明.md");
  });

  it("fragment 剥离：href 保留原文，fragment 单独给出", () => {
    const links = extractDocumentLinks(
      doc(paragraph(textWithLink("章节", "目标页.md#第二节"))),
      "文档/章节.md",
    );
    expect(links[0]).toMatchObject({
      kind: "internal",
      fragment: "第二节",
      targetRelativePath: "文档/目标页.md",
    });
  });

  it("百分号编码 href 原文保留，targetRelativePath 解码归一", () => {
    const links = extractDocumentLinks(
      doc(paragraph(textWithLink("编码", "my%20note.md"))),
      "dir/a.md",
    );
    expect(links[0].href).toBe("my%20note.md");
    expect(links[0].targetRelativePath).toBe("dir/my note.md");
  });

  it("外部协议 / 协议相对 / 绝对路径 → external，无 targetRelativePath", () => {
    const links = extractDocumentLinks(
      doc(
        paragraph(
          textWithLink("官网", "https://example.com/docs/x.md"),
          textWithLink("协议相对", "//cdn.example.com/a.md"),
          textWithLink("绝对", "/abs/path/x.md"),
        ),
      ),
      "a.md",
    );
    expect(links.map((l) => l.kind)).toEqual([
      "external",
      "external",
      "external",
    ]);
    expect(links.every((l) => l.targetRelativePath === null)).toBe(true);
  });

  it("mailto 与纯锚点", () => {
    const links = extractDocumentLinks(
      doc(
        paragraph(
          textWithLink("邮箱", "mailto:a@b.com"),
          textWithLink("锚", "#顶部"),
        ),
      ),
      "a.md",
    );
    expect(links[0]).toMatchObject({ kind: "mailto", fragment: null });
    expect(links[1]).toMatchObject({
      kind: "anchor",
      fragment: "顶部",
      targetRelativePath: null,
    });
  });

  it("相对非 .md 文件链接 → asset 并归一", () => {
    const links = extractDocumentLinks(
      doc(paragraph(textWithLink("设计稿", "../assets/design.pdf"))),
      "目录/页面A.md",
    );
    expect(links[0]).toMatchObject({
      kind: "asset",
      targetRelativePath: "assets/design.pdf",
    });
  });

  it(".. 越过 vault 根 → kind 保持 internal，targetRelativePath 为 null", () => {
    const links = extractDocumentLinks(
      doc(paragraph(textWithLink("逃逸", "../outside.md"))),
      "a.md",
    );
    expect(links[0]).toMatchObject({
      kind: "internal",
      targetRelativePath: null,
    });
  });

  it("空 href 与纯空白 href 不产出条目", () => {
    const links = extractDocumentLinks(
      doc(paragraph(textWithLink("空", ""), textWithLink("空白", "  "))),
      "a.md",
    );
    expect(links).toEqual([]);
  });

  it("非字符串 href（损坏数据）跳过不抛错", () => {
    const links = extractDocumentLinks(
      doc(
        paragraph({
          type: "text",
          text: "损坏",
          marks: [{ type: "link", attrs: { href: 42 } }],
        }),
      ),
      "a.md",
    );
    expect(links).toEqual([]);
  });

  it("代码块中的 Markdown 样例只是 code mark 文本，不产生链接", () => {
    const links = extractDocumentLinks(
      doc({
        type: "codeBlock",
        content: [
          {
            type: "text",
            text: "[假链接](fake.md)",
            marks: [{ type: "code" }],
          },
        ],
      }),
      "a.md",
    );
    expect(links).toEqual([]);
  });
});

describe("extractDocumentLinks：页面引用节点", () => {
  it("internalLink 节点 → internal + knownTargetPageId", () => {
    const links = extractDocumentLinks(
      doc(
        paragraph({
          type: "internalLink",
          attrs: { id: "page-123", label: "目标页面" },
        }),
      ),
      "目录/页面A.md",
    );
    expect(simplify(links)).toEqual([
      {
        href: "",
        label: "目标页面",
        kind: "internal",
        fragment: null,
        targetRelativePath: null,
        knownTargetPageId: "page-123",
      },
    ]);
  });

  it("mention 节点同型处理", () => {
    const links = extractDocumentLinks(
      doc(
        paragraph({ type: "mention", attrs: { id: "page-9", label: "某页" } }),
      ),
      "a.md",
    );
    expect(links[0]).toMatchObject({
      kind: "internal",
      knownTargetPageId: "page-9",
      label: "某页",
    });
  });

  it("缺 id 或 id 为空的引用节点不产出", () => {
    const links = extractDocumentLinks(
      doc(
        paragraph({ type: "internalLink", attrs: { label: "无 id" } }),
        paragraph({ type: "mention", attrs: { id: "", label: "空 id" } }),
      ),
      "a.md",
    );
    expect(links).toEqual([]);
  });
});

describe("extractDocumentLinks：image/attachment 节点", () => {
  it("image 相对 src → asset，label 取 alt", () => {
    const links = extractDocumentLinks(
      doc({
        type: "image",
        attrs: { src: "../assets/示意图.png", alt: "示意图" },
      }),
      "目录/页面A.md",
    );
    expect(simplify(links)).toEqual([
      {
        href: "../assets/示意图.png",
        label: "示意图",
        kind: "asset",
        fragment: null,
        targetRelativePath: "assets/示意图.png",
        knownTargetPageId: null,
      },
    ]);
  });

  it("image 外部 src → external", () => {
    const links = extractDocumentLinks(
      doc({ type: "image", attrs: { src: "https://cdn.example.com/a.png" } }),
      "a.md",
    );
    expect(links[0]).toMatchObject({
      kind: "external",
      targetRelativePath: null,
      label: "",
    });
  });

  it("attachment 相对 src → asset，label 取 name（无 alt 时）", () => {
    const links = extractDocumentLinks(
      doc({ type: "attachment", attrs: { src: "./report.pdf", name: "报告" } }),
      "dir/a.md",
    );
    expect(links[0]).toMatchObject({
      kind: "asset",
      label: "报告",
      targetRelativePath: "dir/report.pdf",
    });
  });

  it("无 src 的 image/attachment（如本地 attachmentId 形态）不产出", () => {
    const links = extractDocumentLinks(
      doc(
        { type: "image", attrs: { alt: "无 src" } },
        { type: "attachment", attrs: { attachmentId: "att-1", name: "附件" } },
      ),
      "a.md",
    );
    expect(links).toEqual([]);
  });
});
