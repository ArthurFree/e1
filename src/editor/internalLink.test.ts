/**
 * internalLink 节点测试（R010 Stage 1）：
 * - 节点 attrs 与渲染（class="internal-link" + data-id）；
 * - 白名单校验（缺 id 视为损坏）；
 * - Markdown 序列化：与 mention 同分支（resolveMentionPath 命中 → 相对
 *   链接，否则降级纯文本 @label + unsupported "internal-link"）；
 * - 解析回读：codec parse 的 resolveInternalLinkTarget 命中 → link mark
 *   文本改写回 internalLink 节点；broken/外部/带锚点保持 link mark；
 * - 点击导航：handleClick 插件命中节点时经 storage 注入回调 pageId。
 */
import { describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { buildDocumentExtensions } from "./extensions";
import { createMarkdownCodec } from "./markdown/codec";
import type { MarkdownAssetResolver } from "./markdown/types";
import {
  parseDocumentContent,
  sanitizeDocumentContent,
} from "../domain/validation/documentContent";

const codec = createMarkdownCodec();

/** 测试用资源路径解析器：与 codec.test.ts 同口径。 */
const testResolver: MarkdownAssetResolver = {
  resolveAssetPath: ({ name }) => `../assets/${name}`,
};

function docWithInternalLink(attrs: { id: string; label: string }) {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "见 " },
          { type: "internalLink", attrs },
        ],
      },
    ],
  };
}

describe("internalLink 节点", () => {
  it("attrs 往返与渲染：span.internal-link[data-id][data-label]", () => {
    const editor = new Editor({
      extensions: buildDocumentExtensions(),
      content: docWithInternalLink({ id: "p1", label: "页面A" }),
    });
    const json = editor.getJSON();
    expect(json.content?.[0]?.content?.[1]).toMatchObject({
      type: "internalLink",
      attrs: { id: "p1", label: "页面A" },
    });
    const html = editor.getHTML();
    expect(html).toContain('class="internal-link"');
    expect(html).toContain('data-id="p1"');
    expect(html).toContain("页面A");
    editor.destroy();
  });

  it("白名单：合法节点通过严格校验，缺 id 视为损坏且修复时丢弃", () => {
    expect(
      parseDocumentContent(docWithInternalLink({ id: "p1", label: "页面A" }))
        .ok,
    ).toBe(true);
    const broken = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "internalLink", attrs: { label: "无 id" } }],
        },
      ],
    };
    expect(parseDocumentContent(broken).ok).toBe(false);
    expect(JSON.stringify(sanitizeDocumentContent(broken))).not.toContain(
      "internalLink",
    );
  });

  it("点击命中节点时经 storage 注入的 onOpenPage 回调 pageId", () => {
    const onOpenPage = vi.fn();
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: buildDocumentExtensions(),
      content: docWithInternalLink({ id: "p1", label: "页面A" }),
    });
    (
      editor.storage as unknown as Record<string, unknown>
    ).internalLinkServices = { onOpenPage };

    let pos = -1;
    editor.state.doc.descendants((node, nodePos) => {
      if (node.type.name === "internalLink") {
        pos = nodePos;
        return false;
      }
      return true;
    });
    expect(pos).toBeGreaterThanOrEqual(0);

    const click = new MouseEvent("click");
    // 落点在节点两侧边界（pos / pos+1）都应命中。
    for (const p of [pos, pos + 1]) {
      const handled = editor.view.someProp("handleClick", (fn) =>
        fn(editor.view, p, click),
      );
      expect(handled).toBe(true);
    }
    expect(onOpenPage).toHaveBeenCalledWith("p1");

    // 普通文本位置不触发导航。
    onOpenPage.mockClear();
    editor.view.someProp("handleClick", (fn) => fn(editor.view, 1, click));
    expect(onOpenPage).not.toHaveBeenCalled();

    editor.destroy();
  });

  it("未注入 onOpenPage 时点击不拦截（保持默认选区行为）", () => {
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: buildDocumentExtensions(),
      content: docWithInternalLink({ id: "p1", label: "页面A" }),
    });
    let pos = -1;
    editor.state.doc.descendants((node, nodePos) => {
      if (node.type.name === "internalLink") {
        pos = nodePos;
        return false;
      }
      return true;
    });
    const handled = editor.view.someProp("handleClick", (fn) =>
      fn(editor.view, pos, new MouseEvent("click")),
    );
    // PM someProp 按真值短路：未拦截时得到 false/undefined，二者都算不拦截。
    expect(handled).toBeFalsy();
    editor.destroy();
  });
});

describe("internalLink Markdown 序列化", () => {
  it("resolveMentionPath 命中时写标准相对链接，否则降级纯文本", async () => {
    const document = docWithInternalLink({ id: "p1", label: "页面A" });
    const resolved = await codec.serialize({
      document,
      metadata: {},
      assetResolver: testResolver,
      mode: "portable",
      resolveMentionPath: (pageId) =>
        pageId === "p1" ? "../工作/页面A.md" : null,
    });
    expect(resolved.markdown).toContain("[页面A](../工作/页面A.md)");
    expect(resolved.lossy).toBe(false);

    const degraded = await codec.serialize({
      document,
      metadata: {},
      assetResolver: testResolver,
      mode: "portable",
    });
    expect(degraded.markdown).toContain("@页面A");
    expect(degraded.lossy).toBe(true);
    expect(degraded.unsupported[0].kind).toBe("internal-link");
  });
});

describe("internalLink 解析回读（resolveInternalLinkTarget）", () => {
  // 归一到 vault 根的路径（来源在 notes/学习/ 下，../ 退一级后为 notes/工作/）。
  const resolve = (targetRelativePath: string) =>
    targetRelativePath === "notes/工作/页面A.md" ? "p1" : null;

  it("相对 .md 链接命中 resolver 时改写为 internalLink 节点", async () => {
    const note = await codec.parse({
      markdown: "见 [页面A](../工作/页面A.md) 了解详情",
      relativePath: "notes/学习/来源.md",
      resolveInternalLinkTarget: resolve,
    });
    const paragraph = (
      note.document as {
        content: { content: Record<string, unknown>[] }[];
      }
    ).content[0];
    expect(paragraph.content[1]).toEqual({
      type: "internalLink",
      attrs: { id: "p1", label: "页面A" },
    });
  });

  it("序列化 → 解析往返：internalLink 节点身份与显示文本保持", async () => {
    const serialized = await codec.serialize({
      document: docWithInternalLink({ id: "p1", label: "页面A" }),
      metadata: {},
      assetResolver: testResolver,
      mode: "portable",
      resolveMentionPath: () => "../工作/页面A.md",
    });
    const parsed = await codec.parse({
      markdown: serialized.markdown,
      relativePath: "notes/学习/来源.md",
      resolveInternalLinkTarget: resolve,
    });
    expect(JSON.stringify(parsed.document)).toContain(
      JSON.stringify({
        type: "internalLink",
        attrs: { id: "p1", label: "页面A" },
      }),
    );
  });

  it("broken/外部链接保持普通 link mark，不丢信息", async () => {
    const note = await codec.parse({
      markdown:
        "见 [目标不存在](../工作/幽灵.md) 与 [外部](https://example.com)",
      relativePath: "notes/学习/来源.md",
      resolveInternalLinkTarget: resolve,
    });
    const json = JSON.stringify(note.document);
    expect(json).not.toContain("internalLink");
    expect(json).toContain("../工作/幽灵.md");
    expect(json).toContain("https://example.com");
  });

  it("带锚点或叠加样式的链接不升级（锚点/mark 无节点字段可携带）", async () => {
    const note = await codec.parse({
      markdown:
        "见 [页面A](../工作/页面A.md#某节) 与 **[页面A](../工作/页面A.md)**",
      relativePath: "notes/学习/来源.md",
      resolveInternalLinkTarget: resolve,
    });
    expect(JSON.stringify(note.document)).not.toContain("internalLink");
  });

  it("未注入 resolver 时保持普通 link mark（Web/导入路径行为不变）", async () => {
    const note = await codec.parse({
      markdown: "见 [页面A](../工作/页面A.md)",
      relativePath: "notes/学习/来源.md",
    });
    const json = JSON.stringify(note.document);
    expect(json).not.toContain("internalLink");
    expect(json).toContain("../工作/页面A.md");
  });
});
