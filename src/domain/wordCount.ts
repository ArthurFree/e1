/**
 * 字数统计（R001 §8.2）：CJK 单字计 1；连续拉丁字母或数字计 1 个词；
 * 标点和空白不计。字符数为非空白字符总数。
 */

export interface WordCountStats {
  /** 非空白字符数。 */
  characters: number;
  /** 词数（CJK 逐字 + 拉丁/数字连续段）。 */
  words: number;
}

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/u;
const LATIN_OR_DIGIT = /[A-Za-z0-9]/;

export function countWords(text: string): WordCountStats {
  let characters = 0;
  let words = 0;
  let inLatinRun = false;
  for (const ch of Array.from(text)) {
    if (/\s/.test(ch)) {
      inLatinRun = false;
      continue;
    }
    characters += 1;
    if (CJK.test(ch)) {
      words += 1;
      inLatinRun = false;
    } else if (LATIN_OR_DIGIT.test(ch)) {
      if (!inLatinRun) {
        words += 1;
        inLatinRun = true;
      }
    } else {
      inLatinRun = false;
    }
  }
  return { characters, words };
}

/** 紧凑展示，例如 “1,528 字词”。 */
export function formatWordCount(words: number): string {
  return `${words.toLocaleString("zh-CN")} 字词`;
}
