/**
 * R006-C4-D §81：Frontmatter / CRLF 往返 golden——打开记下 Source Context，
 * serialize 后未知字段 / tags / aliases / created / CRLF 不丢失。
 */
import { describe, expect, it } from "vitest";
import { createMarkdownCodec } from "../../editor/markdown/codec";
import type { PortableNoteMetadata } from "../../editor/markdown/types";

const noopAssetResolver = {
  resolveAssetPath: () => "assets/x.png",
};

describe("Frontmatter serialize 保留（§81 golden）", () => {
  const codec = createMarkdownCodec();

  async function roundTrip(markdown: string) {
    const parsed = await codec.parse({ markdown, relativePath: "a.md" });
    const metadata: PortableNoteMetadata = {
      id: parsed.metadata.id,
      title: parsed.metadata.title,
      tags: parsed.metadata.tags,
      createdAt: parsed.metadata.createdAt,
      updatedAt: "2026-08-13T12:00:00.000Z",
      aliases: parsed.metadata.aliases,
      extra: parsed.metadata.extra,
    };
    const serialized = await codec.serialize({
      document: parsed.document,
      metadata,
      assetResolver: noopAssetResolver,
      mode: "portable",
      lineEnding: parsed.lineEnding,
    });
    return { parsed, serialized, metadata };
  }

  it("标准 Frontmatter：id/title/tags/created/aliases 保留，updated 更新", async () => {
    const src = [
      "---",
      "id: 01JABC",
      "title: React",
      "tags: [前端, 笔记]",
      "created: 2026-01-01T00:00:00.000Z",
      "updated: 2026-01-02T00:00:00.000Z",
      "aliases: [React Fiber]",
      "---",
      "",
      "# React",
      "",
      "正文。",
      "",
    ].join("\n");
    const { serialized } = await roundTrip(src);
    expect(serialized.lossy).toBe(false);
    expect(serialized.markdown).toContain("id: 01JABC");
    expect(serialized.markdown).toContain("title: React");
    expect(serialized.markdown).toContain("前端");
    expect(serialized.markdown).toContain("created: 2026-01-01T00:00:00.000Z");
    expect(serialized.markdown).toContain("updated: 2026-08-13T12:00:00.000Z");
    expect(serialized.markdown).toContain("React Fiber");
    expect(serialized.markdown).toContain("# React");
  });

  it("未知字段与嵌套 rawLines 原样保留", async () => {
    const src = [
      "---",
      "id: abc",
      "title: React",
      "cssclass: custom-note",
      "obsidian-plugin-x: true",
      "my-field:",
      "  - foo",
      "  - bar",
      "---",
      "",
      "正文",
      "",
    ].join("\n");
    const { serialized, parsed } = await roundTrip(src);
    expect(parsed.metadata.extra.map((e) => e.key)).toEqual(
      expect.arrayContaining(["cssclass", "obsidian-plugin-x", "my-field"]),
    );
    expect(serialized.markdown).toContain("cssclass: custom-note");
    expect(serialized.markdown).toContain("obsidian-plugin-x: true");
    expect(serialized.markdown).toContain("my-field:");
  });

  it("CRLF 输入 → serialize 输出 CRLF", async () => {
    const src = "---\r\nid: n1\r\ntitle: T\r\n---\r\n\r\n# 标题\r\n";
    const { serialized, parsed } = await roundTrip(src);
    expect(parsed.lineEnding).toBe("crlf");
    expect(serialized.markdown.includes("\r\n")).toBe(true);
  });

  it("无 Frontmatter：serialize 可按 metadata 补写", async () => {
    const parsed = await codec.parse({
      markdown: "# React\n\n正文\n",
      relativePath: "React.md",
    });
    const serialized = await codec.serialize({
      document: parsed.document,
      metadata: {
        id: "01NEW",
        title: "React",
        tags: [],
        createdAt: "2026-08-13T00:00:00.000Z",
        updatedAt: "2026-08-13T00:00:00.000Z",
        aliases: [],
      },
      assetResolver: noopAssetResolver,
      mode: "portable",
      lineEnding: "lf",
    });
    expect(serialized.markdown).toContain("id: 01NEW");
    expect(serialized.markdown).toContain("# React");
  });
});
