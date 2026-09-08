/**
 * R011.1（R11C-06）：frontmatterBodyStartOffset 的 CRLF/BOM 行为测试。
 * splitFrontmatter / generateFrontmatter / ensureFrontmatterId 的既有行为
 * 测试见 src/editor/markdown/frontmatter.test.ts（经 re-export 测同一实现）。
 */
import { describe, expect, it } from "vitest";
import { frontmatterBodyStartOffset } from "./frontmatter.js";

describe("frontmatterBodyStartOffset", () => {
  it("LF：偏移指向正文起点（slice 校验）", () => {
    const md = "---\nid: 1\n---\n\n正文\n";
    expect(md.slice(frontmatterBodyStartOffset(md))).toBe("正文\n");
  });

  it("CRLF：\\r 留在行尾不产生偏移漂移", () => {
    const md = "---\r\nid: 1\r\n---\r\n\r\n正文\r\n";
    expect(md.slice(frontmatterBodyStartOffset(md))).toBe("正文\r\n");
  });

  it("BOM + CRLF：BOM 视为前缀，之后紧跟 --- 仍算 Frontmatter", () => {
    const md = "\uFEFF---\r\nid: 1\r\n---\r\n\r\n正文\r\n";
    const offset = frontmatterBodyStartOffset(md);
    expect(md.slice(offset)).toBe("正文\r\n");
    // BOM 计入 Frontmatter 前缀区域。
    expect(md.slice(0, offset).startsWith("\uFEFF---")).toBe(true);
  });

  it("闭合行后无空行：正文紧随 ---", () => {
    const md = "---\nid: 1\n---\n正文";
    expect(md.slice(frontmatterBodyStartOffset(md))).toBe("正文");
  });

  it("无 Frontmatter：返回 0（BOM 前缀文档同样为 0）", () => {
    expect(frontmatterBodyStartOffset("# 标题\n正文")).toBe(0);
    expect(frontmatterBodyStartOffset("\uFEFF# 标题\n正文")).toBe(0);
  });

  it("首行 --- 无闭合：返回 0（与 splitFrontmatter 判定一致）", () => {
    expect(frontmatterBodyStartOffset("---\nid: 1\n正文")).toBe(0);
  });

  it("Frontmatter 无正文：返回整串长度", () => {
    const md = "---\r\nid: 1\r\n---\r\n";
    expect(frontmatterBodyStartOffset(md)).toBe(md.length);
    const noTrailing = "---\nid: 1\n---";
    expect(frontmatterBodyStartOffset(noTrailing)).toBe(noTrailing.length);
  });
});
