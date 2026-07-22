import { describe, expect, it } from "vitest";
import { countWords, formatWordCount } from "./wordCount";

describe("countWords", () => {
  it("空文本为 0", () => {
    expect(countWords("")).toEqual({ characters: 0, words: 0 });
    expect(countWords("  \n ")).toEqual({ characters: 0, words: 0 });
  });

  it("中文逐字计词", () => {
    expect(countWords("你好世界").words).toBe(4);
  });

  it("连续拉丁字母或数字计一个词", () => {
    expect(countWords("hello world 2024").words).toBe(3);
    expect(countWords("abc123").words).toBe(1);
  });

  it("中英混排", () => {
    // 使/用/Tiptap/编/辑/器 = 6 个词
    expect(countWords("使用 Tiptap 编辑器").words).toBe(6);
  });

  it("标点不计词但计入字符数", () => {
    const stats = countWords("你好，世界！");
    expect(stats.words).toBe(4);
    expect(stats.characters).toBe(6);
  });

  it("空白不计入字符数", () => {
    expect(countWords("a b").characters).toBe(2);
  });
});

describe("formatWordCount", () => {
  it("紧凑展示", () => {
    expect(formatWordCount(1528)).toBe("1,528 字词");
    expect(formatWordCount(3)).toBe("3 字词");
  });
});
