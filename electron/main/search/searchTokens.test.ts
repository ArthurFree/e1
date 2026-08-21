// @vitest-environment node
/**
 * R008 Stage 4（§11.4 中文方案 B）：应用层 bigram/unigram 分词测试。
 * 召回完备性由「子串匹配 ⇒ token 覆盖」论证支撑，这里锁定具体行为：
 * 中文/英文/混合分段、单字符 unigram、大小写归一、emoji/标点分段、
 * 代理对安全与索引侧去重。
 */
import { describe, expect, it } from "vitest";
import {
  normalizeSearchText,
  tokenizeForSearchIndex,
  tokenizeForSearchQuery,
} from "./searchTokens.js";

describe("normalizeSearchText", () => {
  it("Unicode 小写化", () => {
    expect(normalizeSearchText("REACT性能ABC")).toBe("react性能abc");
  });
});

describe("tokenizeForSearchQuery", () => {
  it("中文段发出全部重叠 bigram", () => {
    expect(tokenizeForSearchQuery("知识库")).toEqual(["知识", "识库"]);
  });

  it("单字符段发 unigram", () => {
    expect(tokenizeForSearchQuery("库")).toEqual(["库"]);
  });

  it("英文段发小写 bigram", () => {
    expect(tokenizeForSearchQuery("react")).toEqual([
      "re",
      "ea",
      "ac",
      "ct",
    ]);
  });

  it("多段查询按段分别发 token（跨空白/标点）", () => {
    expect(tokenizeForSearchQuery("react 性能")).toEqual([
      "re",
      "ea",
      "ac",
      "ct",
      "性能",
    ]);
  });

  it("纯 emoji/标点查询无 token（调用方回退 instr 召回）", () => {
    expect(tokenizeForSearchQuery("🚀")).toEqual([]);
    expect(tokenizeForSearchQuery("！！")).toEqual([]);
  });
});

describe("tokenizeForSearchIndex", () => {
  it("每段发 unigram + bigram，大小写归一", () => {
    const tokens = tokenizeForSearchIndex("React 知识库");
    expect(tokens).toEqual(
      expect.arrayContaining([
        "r",
        "e",
        "a",
        "c",
        "t",
        "re",
        "ea",
        "ac",
        "ct",
        "知",
        "识",
        "库",
        "知识",
        "识库",
      ]),
    );
  });

  it("token 去重（重复词不重复存储）", () => {
    const tokens = tokenizeForSearchIndex("知识知识");
    expect(tokens.filter((t) => t === "知识")).toHaveLength(1);
    expect(tokens.filter((t) => t === "知")).toHaveLength(1);
  });

  it("长英文词完整覆盖其全部 bigram（子串召回完备）", () => {
    const tokens = new Set(tokenizeForSearchIndex("reaction"));
    for (const bigram of ["re", "ea", "ac", "ct"]) {
      expect(tokens.has(bigram)).toBe(true);
    }
  });

  it("emoji 作为分段符不产生 token", () => {
    expect(tokenizeForSearchIndex("🚀🧳")).toEqual([]);
  });
});
