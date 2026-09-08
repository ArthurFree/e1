/**
 * R012 Stage 5（需求 §27/§39）：computeLineDiff 行级 diff 单测——
 * 增/删/改/上下文、空文档、超大降级（返回 null 由 UI 提示）。
 */
import { describe, expect, it } from "vitest";
import { computeLineDiff, DIFF_MAX_TOTAL_LINES } from "./lineDiff";

describe("computeLineDiff", () => {
  it("纯新增行标记 added，共有行保持 context", () => {
    expect(computeLineDiff("a\nb", "a\nx\nb")).toEqual([
      { type: "context", text: "a" },
      { type: "added", text: "x" },
      { type: "context", text: "b" },
    ]);
  });

  it("纯删除行标记 removed", () => {
    expect(computeLineDiff("a\nx\nb", "a\nb")).toEqual([
      { type: "context", text: "a" },
      { type: "removed", text: "x" },
      { type: "context", text: "b" },
    ]);
  });

  it("修改行 = removed + added（先删后增），上下文不变", () => {
    expect(computeLineDiff("开头\n旧内容\n结尾", "开头\n新内容\n结尾")).toEqual(
      [
        { type: "context", text: "开头" },
        { type: "removed", text: "旧内容" },
        { type: "added", text: "新内容" },
        { type: "context", text: "结尾" },
      ],
    );
  });

  it("两段完全不同：全部 removed 后接全部 added", () => {
    expect(computeLineDiff("a\nb", "x\ny")).toEqual([
      { type: "removed", text: "a" },
      { type: "removed", text: "b" },
      { type: "added", text: "x" },
      { type: "added", text: "y" },
    ]);
  });

  it("两侧相同 → 全部 context，无 added/removed", () => {
    const lines = computeLineDiff("同\n文\n本", "同\n文\n本");
    expect(lines).toEqual([
      { type: "context", text: "同" },
      { type: "context", text: "文" },
      { type: "context", text: "本" },
    ]);
  });

  it("空文档 vs 空文档 → 单行空 context", () => {
    expect(computeLineDiff("", "")).toEqual([{ type: "context", text: "" }]);
  });

  it("空文档 → 有内容：旧空行 removed + 新行 added", () => {
    expect(computeLineDiff("", "新行")).toEqual([
      { type: "removed", text: "" },
      { type: "added", text: "新行" },
    ]);
  });

  it("公共前缀/后缀裁剪不影响结果（中段局部编辑）", () => {
    const before = ["h1", "h2", "旧", "t1", "t2"].join("\n");
    const after = ["h1", "h2", "新1", "新2", "t1", "t2"].join("\n");
    expect(computeLineDiff(before, after)).toEqual([
      { type: "context", text: "h1" },
      { type: "context", text: "h2" },
      { type: "removed", text: "旧" },
      { type: "added", text: "新1" },
      { type: "added", text: "新2" },
      { type: "context", text: "t1" },
      { type: "context", text: "t2" },
    ]);
  });

  it("行数过大（两边合计 > 上限）→ null（UI 降级提示）", () => {
    const big = Array.from(
      { length: Math.floor(DIFF_MAX_TOTAL_LINES / 2) + 1 },
      (_, i) => `行${i}`,
    ).join("\n");
    expect(computeLineDiff(big, big)).toBeNull();
  });

  it("行数恰在上限内 → 正常计算", () => {
    const half = Math.floor(DIFF_MAX_TOTAL_LINES / 2);
    const a = Array.from({ length: half }, (_, i) => `a${i}`).join("\n");
    const b = Array.from(
      { length: DIFF_MAX_TOTAL_LINES - half },
      (_, i) => `a${i}`,
    ).join("\n");
    const lines = computeLineDiff(a, b);
    expect(lines).not.toBeNull();
    expect(lines?.every((l) => l.type === "context")).toBe(true);
  });
});
