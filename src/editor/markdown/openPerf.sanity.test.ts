/**
 * R006-C3 §45 性能 sanity（Renderer 段，计时记录不设硬 SLA）：
 * 典型 100 KB Markdown 的 MarkdownCodec.parse 计时（note open 链路
 * 「点击 → 正文可见」的 Renderer 段；Main 段见
 * electron/main/filesystem/scanPerf.sanity.test.ts）。
 */
import { describe, expect, it } from "vitest";
import { createMarkdownCodec } from "./codec";

/** 生成约 100 KB 的 Markdown（标题 + 重复段落，与 Main 段基准同形）。 */
function makeLargeMarkdown(): string {
  const paragraph =
    "这是一段用于性能基准的正文文本，包含中英文混排与常用标点，用来模拟真实笔记的内容密度。\n\n";
  const body = paragraph.repeat(Math.ceil((100 * 1024) / paragraph.length));
  return `# 大文档\n\n${body}`;
}

describe("R006-C3 §45 性能 sanity（Renderer 段）", () => {
  it("MarkdownCodec.parse 解析 100 KB Markdown", async () => {
    const codec = createMarkdownCodec();
    const markdown = makeLargeMarkdown();
    const t0 = performance.now();
    const result = await codec.parse({
      markdown,
      relativePath: "大文档.md",
    });
    const elapsed = performance.now() - t0;
    console.log(`[perf] MarkdownCodec.parse 100 KB: ${elapsed.toFixed(0)}ms`);
    expect((result.document as { type?: string }).type).toBe("doc");
  });
});
