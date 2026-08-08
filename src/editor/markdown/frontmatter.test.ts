/**
 * Frontmatter 最小 YAML 子集解析/生成单元测试（R005 阶段 4，批次 4A）。
 */
import { describe, expect, it } from "vitest";
import { generateFrontmatter, splitFrontmatter } from "./frontmatter";

describe("splitFrontmatter", () => {
  it("无 Frontmatter 时原样返回正文", () => {
    const result = splitFrontmatter("# 标题\n\n正文");
    expect(result.hasFrontmatter).toBe(false);
    expect(result.body).toBe("# 标题\n\n正文");
    expect(result.metadata).toEqual({ tags: [], aliases: [], extra: [] });
  });

  it("首行 --- 无闭合时不视为 Frontmatter（避免与水平线混淆）", () => {
    const result = splitFrontmatter("---\n\n# 标题");
    expect(result.hasFrontmatter).toBe(false);
    expect(result.body).toBe("---\n\n# 标题");
  });

  it("解析标量与两种列表写法", () => {
    const result = splitFrontmatter(
      [
        "---",
        "id: abc123",
        "title: 标题",
        "tags: [React, 前端]",
        "aliases:",
        "  - 别名一",
        "  - 别名二",
        "created: 2026-07-28T10:00:00+08:00",
        "---",
        "",
        "正文",
      ].join("\n"),
    );
    expect(result.hasFrontmatter).toBe(true);
    expect(result.metadata).toEqual({
      id: "abc123",
      title: "标题",
      tags: ["React", "前端"],
      aliases: ["别名一", "别名二"],
      createdAt: "2026-07-28T10:00:00+08:00",
      extra: [],
    });
    expect(result.body).toBe("正文");
  });

  it("带引号的值去引号并反转义", () => {
    const result = splitFrontmatter(
      ["---", 'title: "含 \\"引号\\" 的标题"', "---", "正文"].join("\n"),
    );
    expect(result.metadata.title).toBe('含 "引号" 的标题');
  });

  it("未知字段整段原始行保序保留（含块式续行）", () => {
    const result = splitFrontmatter(
      [
        "---",
        "id: abc",
        "x-custom: 自定义值",
        "x-nested:",
        "  - 第一项",
        "  - 第二项",
        "title: 标题",
        "---",
        "正文",
      ].join("\n"),
    );
    expect(result.metadata.extra).toEqual([
      { key: "x-custom", rawLines: ["x-custom: 自定义值"] },
      {
        key: "x-nested",
        rawLines: ["x-nested:", "  - 第一项", "  - 第二项"],
      },
    ]);
    expect(result.metadata.id).toBe("abc");
    expect(result.metadata.title).toBe("标题");
  });

  it("标量形态的 tags 归一为单元素列表", () => {
    const result = splitFrontmatter("---\ntags: 单个\n---\n正文");
    expect(result.metadata.tags).toEqual(["单个"]);
  });
});

describe("generateFrontmatter", () => {
  it("无字段时返回空串（调用方省略整块）", () => {
    expect(generateFrontmatter({})).toBe("");
    expect(generateFrontmatter({ tags: [], aliases: [] })).toBe("");
  });

  it("按固定顺序输出已知字段，extra 原样附后", () => {
    const output = generateFrontmatter({
      id: "abc123",
      title: "标题",
      tags: ["React", "前端"],
      createdAt: "2026-07-28T10:00:00+08:00",
      updatedAt: "2026-07-28T11:00:00+08:00",
      aliases: ["别名"],
      extra: [{ key: "x-custom", rawLines: ["x-custom: 自定义值"] }],
    });
    expect(output).toBe(
      [
        "---",
        "id: abc123",
        "title: 标题",
        "tags: [React, 前端]",
        "created: 2026-07-28T10:00:00+08:00",
        "updated: 2026-07-28T11:00:00+08:00",
        "aliases: [别名]",
        "x-custom: 自定义值",
        "---",
      ].join("\n"),
    );
  });

  it("特殊字符标量加引号（含冒号空格 / 布尔形似 / 数字开头）", () => {
    const output = generateFrontmatter({
      title: "副标题: 说明",
      id: "true",
      tags: ["2026", "含,逗号"],
    });
    expect(output).toContain('title: "副标题: 说明"');
    expect(output).toContain('id: "true"');
    expect(output).toContain('tags: ["2026", "含,逗号"]');
  });

  it("生成 → 解析往返：字段值不变", () => {
    const metadata = {
      id: "abc123",
      title: "含: 特殊字符",
      tags: ["React", "2026"],
      createdAt: "2026-07-28T10:00:00+08:00",
      aliases: ["别名 一"],
    };
    const roundtripped = splitFrontmatter(
      `${generateFrontmatter(metadata)}\n\n正文`,
    );
    expect(roundtripped.metadata).toEqual({ ...metadata, extra: [] });
  });
});
