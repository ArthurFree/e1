/**
 * shared/revisions/rawMarkdownBody 单元测试（R012 Stage 0）：
 * raw body 拆分（LF/CRLF/BOM、无/有/未知字段 Frontmatter）、
 * 行尾与 BOM 探测、textPreview 提取（中文/emoji/空格/空 body/大 body）。
 */
import { describe, expect, it } from "vitest";
import {
  detectLineEnding,
  extractRevisionTextPreview,
  REVISION_TEXT_PREVIEW_MAX_CHARS,
  splitRawMarkdownBody,
} from "./rawMarkdownBody.js";

const FRONTMATTER = ["---", "id: 01ABC", "title: 示例", "---"].join("\n");

describe("splitRawMarkdownBody", () => {
  it("无 Frontmatter：body 为整个输入", () => {
    const md = "第一行\n第二行\n";
    const split = splitRawMarkdownBody(md);
    expect(split.body).toBe(md);
    expect(split.hasFrontmatter).toBe(false);
    expect(split.hasBom).toBe(false);
    expect(split.lineEnding).toBe("lf");
  });

  it("有 Frontmatter（LF）：body 为原串子串，逐字节一致", () => {
    const md = `${FRONTMATTER}\n\n正文内容\n`;
    const split = splitRawMarkdownBody(md);
    expect(split.body).toBe("正文内容\n");
    expect(split.hasFrontmatter).toBe(true);
    // body 必须是原串的 slice：拼接 Frontmatter 区域 + body 等于原串。
    expect(md.endsWith(split.body)).toBe(true);
    expect(md.slice(0, md.length - split.body.length)).toContain("id: 01ABC");
  });

  it("有 Frontmatter（CRLF）：body 保留 CRLF，不归一化", () => {
    const md = `${FRONTMATTER.replace(/\n/g, "\r\n")}\r\n\r\n第一段\r\n第二段\r\n`;
    const split = splitRawMarkdownBody(md);
    expect(split.body).toBe("第一段\r\n第二段\r\n");
    expect(split.hasFrontmatter).toBe(true);
    expect(split.lineEnding).toBe("crlf");
  });

  it("BOM + Frontmatter：BOM 计入 Frontmatter 区域，body 不含 BOM", () => {
    const md = `\uFEFF${FRONTMATTER}\n\n正文\n`;
    const split = splitRawMarkdownBody(md);
    expect(split.hasBom).toBe(true);
    expect(split.hasFrontmatter).toBe(true);
    expect(split.body).toBe("正文\n");
  });

  it("BOM 但无 Frontmatter：body 为整个输入（含 BOM）", () => {
    const md = "\uFEFF纯文本正文\n";
    const split = splitRawMarkdownBody(md);
    expect(split.hasBom).toBe(true);
    expect(split.hasFrontmatter).toBe(false);
    expect(split.body).toBe(md);
  });

  it("Frontmatter 含未知字段：边界判定不受影响", () => {
    const md = [
      "---",
      "id: 01ABC",
      "custom-field: 自定义值",
      "  续行内容",
      "---",
      "",
      "正文",
    ].join("\n");
    const split = splitRawMarkdownBody(md);
    expect(split.hasFrontmatter).toBe(true);
    expect(split.body).toBe("正文");
  });

  it("Frontmatter 后无正文：body 为空串", () => {
    const md = `${FRONTMATTER}\n`;
    const split = splitRawMarkdownBody(md);
    expect(split.body).toBe("");
    expect(split.hasFrontmatter).toBe(true);
  });

  it("未闭合的 --- 块不视为 Frontmatter（避免与 horizontalRule 混淆）", () => {
    const md = "---\n这不是 Frontmatter\n";
    const split = splitRawMarkdownBody(md);
    expect(split.hasFrontmatter).toBe(false);
    expect(split.body).toBe(md);
  });

  it("空输入：body 空、无 Frontmatter、无 BOM、行尾 lf", () => {
    const split = splitRawMarkdownBody("");
    expect(split).toEqual({
      body: "",
      hasFrontmatter: false,
      hasBom: false,
      lineEnding: "lf",
    });
  });

  it("闭合行后只跳过一个空行：多个空行的其余部分留在 body", () => {
    const md = `${FRONTMATTER}\n\n\n正文`;
    const split = splitRawMarkdownBody(md);
    expect(split.body).toBe("\n正文");
  });
});

describe("detectLineEnding", () => {
  it("LF / CRLF / 无换行", () => {
    expect(detectLineEnding("a\nb")).toBe("lf");
    expect(detectLineEnding("a\r\nb")).toBe("crlf");
    expect(detectLineEnding("单行无换行")).toBe("lf");
    expect(detectLineEnding("")).toBe("lf");
  });

  it("以第一个换行为准：CRLF 开头后续混入 LF 仍报 crlf", () => {
    expect(detectLineEnding("a\r\nb\nc")).toBe("crlf");
    expect(detectLineEnding("a\nb\r\nc")).toBe("lf");
  });

  it("首字符即换行：报 lf（前面不可能有 \\r）", () => {
    expect(detectLineEnding("\nabc")).toBe("lf");
  });
});

describe("extractRevisionTextPreview", () => {
  it("剥离块级标记：标题/引用/列表/任务", () => {
    const body = [
      "# 标题一",
      "> 引用的内容",
      "- 无序项",
      "1. 有序项",
      "- [ ] 待办事项",
      "- [x] 已完成",
    ].join("\n");
    expect(extractRevisionTextPreview(body)).toBe(
      "标题一 引用的内容 无序项 有序项 待办事项 已完成",
    );
  });

  it("剥除行内标记：强调/删除线/行内代码/链接/图片", () => {
    const body =
      "这是 **加粗** 与 ~~删除~~ 与 `code` 与 [链接文字](./a.md) 与 ![图片描述](assets/x.png)";
    expect(extractRevisionTextPreview(body)).toBe(
      "这是 加粗 与 删除 与 code 与 链接文字 与 图片描述",
    );
  });

  it("fenced code：围栏行剔除，代码内容按原文计入", () => {
    const body = ["前文", "```ts", "const a = 1;", "```", "后文"].join("\n");
    expect(extractRevisionTextPreview(body)).toBe("前文 const a = 1; 后文");
  });

  it("水平线与表格分隔行不产生文本", () => {
    const body = [
      "上文",
      "---",
      "| 列一 | 列二 |",
      "| --- | --- |",
      "| 甲 | 乙 |",
    ].join("\n");
    expect(extractRevisionTextPreview(body)).toBe("上文 列一 列二 甲 乙");
  });

  it("中文 / emoji / 空格：折叠连续空白，保留非 ASCII 内容", () => {
    const body = "你好   世界 🎉\n\n\n下一段  内容";
    expect(extractRevisionTextPreview(body)).toBe("你好 世界 🎉 下一段 内容");
  });

  it("CRLF 行尾被剥离，不进入预览", () => {
    expect(extractRevisionTextPreview("第一段\r\n第二段\r\n")).toBe(
      "第一段 第二段",
    );
  });

  it("空 body / 纯标记 body：返回空串", () => {
    expect(extractRevisionTextPreview("")).toBe("");
    expect(extractRevisionTextPreview("\n\n---\n")).toBe("");
  });

  it("大 body：截断到 maxChars", () => {
    const body = "字".repeat(1000);
    const preview = extractRevisionTextPreview(body);
    expect(preview).toHaveLength(REVISION_TEXT_PREVIEW_MAX_CHARS);
    expect(preview).toBe("字".repeat(REVISION_TEXT_PREVIEW_MAX_CHARS));
  });

  it("自定义 maxChars", () => {
    expect(extractRevisionTextPreview("一二三四五", 3)).toBe("一二三");
  });
});
