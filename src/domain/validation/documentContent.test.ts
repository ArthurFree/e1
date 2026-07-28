/**
 * 正文 JSON 运行时校验测试（R003 阶段 4）：
 * - 真实文档 fixture（内置模板）全部通过严格校验；
 * - 各类损坏形态被拒且错误码为 CORRUPTED_DOCUMENT；
 * - sanitize 保留合法子树、剔除非法部分，返回值恒为合法 doc；
 * - 白名单与 extensions.ts 的真实 schema 保持同步（防漂移）。
 */
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import Mention from "@tiptap/extension-mention";
import { buildDocumentExtensions } from "../../editor/extensions";
import { DOC_TEMPLATES } from "../../editor/templates";
import { isDomainError } from "../errors";
import {
  ALLOWED_MARK_TYPES,
  ALLOWED_NODE_TYPES,
  parseDocumentContent,
  sanitizeDocumentContent,
} from "./documentContent";

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };

const corruptCases: [string, unknown][] = [
  ["根不是对象", "not a doc"],
  ["根不是 doc", { type: "paragraph" }],
  ["content 不是数组", { type: "doc", content: "x" }],
  ["未知节点类型", { type: "doc", content: [{ type: "evilNode" }] }],
  ["节点缺少 type", { type: "doc", content: [{ text: "x" }] }],
  [
    "content 嵌套非数组",
    { type: "doc", content: [{ type: "paragraph", content: "x" }] },
  ],
  [
    "非文本节点带 text",
    { type: "doc", content: [{ type: "paragraph", text: "x" }] },
  ],
  ["文本节点缺 text", { type: "doc", content: [{ type: "text" }] }],
  ["attrs 非对象", { type: "doc", content: [{ type: "image", attrs: "x" }] }],
  ["image 缺 src", { type: "doc", content: [{ type: "image", attrs: {} }] }],
  [
    "attachment 缺 attachmentId",
    { type: "doc", content: [{ type: "attachment", attrs: {} }] },
  ],
  [
    "localImage 缺 attachmentId",
    { type: "doc", content: [{ type: "localImage", attrs: {} }] },
  ],
  [
    "localImage attachmentId 类型错误",
    {
      type: "doc",
      content: [{ type: "localImage", attrs: { attachmentId: 1 } }],
    },
  ],
  [
    "mention id 类型错误",
    {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "mention", attrs: { id: 1 } }] },
      ],
    },
  ],
  [
    "未知 mark",
    {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "x", marks: [{ type: "evilMark" }] }],
        },
      ],
    },
  ],
  ["嵌套 doc", { type: "doc", content: [{ type: "doc" }] }],
];

describe("parseDocumentContent", () => {
  it("接受空文档与全部内置模板", () => {
    expect(parseDocumentContent(EMPTY_DOC).ok).toBe(true);
    for (const template of DOC_TEMPLATES) {
      const result = parseDocumentContent(template.content);
      expect(result.ok, `模板「${template.name}」应通过校验`).toBe(true);
    }
  });

  it("接受空 content 与缺省 content", () => {
    expect(parseDocumentContent({ type: "doc", content: [] }).ok).toBe(true);
    expect(parseDocumentContent({ type: "doc" }).ok).toBe(true);
  });

  it("接受合法的 localImage 节点（R004 阶段 6）", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "localImage",
          attrs: { attachmentId: "a1", alt: "图", width: 320 },
        },
      ],
    };
    expect(parseDocumentContent(doc).ok).toBe(true);
  });

  for (const [name, raw] of corruptCases) {
    it(`拒绝损坏内容：${name}`, () => {
      const result = parseDocumentContent(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(isDomainError(result.error, "CORRUPTED_DOCUMENT")).toBe(true);
        expect(result.raw).toBe(raw);
      }
    });
  }
});

describe("sanitizeDocumentContent", () => {
  it("无法解析的输入返回空文档", () => {
    expect(sanitizeDocumentContent("junk")).toEqual({
      type: "doc",
      content: [],
    });
    expect(sanitizeDocumentContent({ type: "doc", content: "x" })).toEqual({
      type: "doc",
      content: [],
    });
  });

  it("保留合法子树、剔除非法节点", () => {
    const raw = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "保留我" }] },
        { type: "evilNode" },
        { type: "paragraph", content: [{ type: "text", text: "也保留" }] },
      ],
    };
    const doc = sanitizeDocumentContent(raw);
    expect(parseDocumentContent(doc).ok).toBe(true);
    const texts = JSON.stringify(doc);
    expect(texts).toContain("保留我");
    expect(texts).toContain("也保留");
    expect(texts).not.toContain("evilNode");
  });

  it("未知节点提升其合法子内容", () => {
    const raw = {
      type: "doc",
      content: [
        {
          type: "evilWrapper",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "提升我" }] },
          ],
        },
      ],
    };
    const doc = sanitizeDocumentContent(raw);
    expect(JSON.stringify(doc)).toContain("提升我");
  });

  it("剔除非法 marks，保留合法 marks", () => {
    const raw = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "加粗",
              marks: [{ type: "bold" }, { type: "evilMark" }],
            },
          ],
        },
      ],
    };
    const doc = sanitizeDocumentContent(raw);
    const text = doc.content?.[0]?.content?.[0];
    expect(text?.marks).toEqual([{ type: "bold" }]);
  });

  it("修复结果总能通过严格校验", () => {
    for (const [, raw] of corruptCases) {
      expect(parseDocumentContent(sanitizeDocumentContent(raw)).ok).toBe(true);
    }
  });
});

describe("白名单与编辑器 schema 同步", () => {
  it("ALLOWED_* 覆盖 buildDocumentExtensions 注册的全部节点与标记", () => {
    // 与 markdown.ts 转换器相同的扩展组合，保证白名单覆盖导入/编辑全路径。
    const editor = new Editor({
      extensions: [
        ...buildDocumentExtensions(),
        Mention.configure({ HTMLAttributes: { class: "mention" } }),
      ],
      content: EMPTY_DOC,
    });
    const schemaNodes = Object.keys(editor.schema.nodes);
    const schemaMarks = Object.keys(editor.schema.marks);
    editor.destroy();

    for (const node of schemaNodes) {
      expect(ALLOWED_NODE_TYPES.has(node), `白名单缺少节点: ${node}`).toBe(
        true,
      );
    }
    for (const mark of schemaMarks) {
      expect(ALLOWED_MARK_TYPES.has(mark), `白名单缺少标记: ${mark}`).toBe(
        true,
      );
    }
  });
});
