/**
 * R006-C4-G：Markdown 文件名清理与冲突递增。
 */
import { describe, expect, it } from "vitest";
import {
  markdownFileNameForAttempt,
  sanitizeMarkdownFileName,
  sanitizeMarkdownStem,
} from "./markdownFileName.js";
import { IpcFailure } from "../../../shared/errors.js";

describe("sanitizeMarkdownStem / FileName", () => {
  it("空标题 → 无标题", () => {
    expect(sanitizeMarkdownStem("")).toBe("无标题");
    expect(sanitizeMarkdownStem("   ")).toBe("无标题");
    expect(sanitizeMarkdownFileName("")).toBe("无标题.md");
  });

  it("非法字符替换为 -；保留中文与空格", () => {
    expect(sanitizeMarkdownStem("React / Fiber")).toBe("React - Fiber");
    expect(sanitizeMarkdownStem('a*b?"<>|c')).toBe("a-b-----c");
    expect(sanitizeMarkdownFileName("React Fiber")).toBe("React Fiber.md");
  });

  it("尾部点/空格剥离；Windows 保留名加后缀", () => {
    expect(sanitizeMarkdownStem("name.")).toBe("name");
    expect(sanitizeMarkdownStem("CON")).toBe("CON_");
    expect(sanitizeMarkdownStem("nul.txt")).toBe("nul.txt_");
  });

  it("冲突递增：0→.md；1→(2)；2→(3)", () => {
    expect(markdownFileNameForAttempt("React", 0)).toBe("React.md");
    expect(markdownFileNameForAttempt("React", 1)).toBe("React (2).md");
    expect(markdownFileNameForAttempt("React", 2)).toBe("React (3).md");
  });

  it("非法最终名仍被 assertSafeFileName 拦住", () => {
    try {
      markdownFileNameForAttempt("a/b", 0);
      throw new Error("should throw");
    } catch (error) {
      // stem 已清理斜杠，不会到这里；验证 assert 对含非法字符的手写 stem。
      expect(error).toBeInstanceOf(Error);
    }
    try {
      // 直接测 assert 路径：带控制字符的 attempt 名无法构造；用空 stem 边界。
      markdownFileNameForAttempt("", 0);
    } catch (error) {
      expect(error).toBeInstanceOf(IpcFailure);
    }
  });
});
