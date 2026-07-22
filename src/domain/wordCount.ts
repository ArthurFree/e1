/**
 * 字数统计（R001 §8.2）：CJK 单字计 1；连续拉丁字母或数字计 1 个词；
 * 标点和空白不计。字符数为非空白字符总数。
 * 与编辑器字数展示（WordCount 组件）共用同一套口径。
 */

export interface WordCountStats {
  /** 非空白字符数。 */
  characters: number;
  /** 词数（CJK 逐字 + 拉丁/数字连续段）。 */
  words: number;
}

/** CJK 统一表意文字（含扩展 A、兼容区）及日文假名、韩文音节。 */
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/u;
const LATIN_OR_DIGIT = /[A-Za-z0-9]/;

export function countWords(text: string): WordCountStats {
  let characters = 0;
  let words = 0;
  // inLatinRun 标记是否处于连续拉丁/数字段中：整段只计 1 个词，
  // 遇到空白、CJK 或标点即结束当前段。
  let inLatinRun = false;
  // Array.from 按码点迭代而非 UTF-16 码元，避免代理对把 CJK 扩展区字符切碎。
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
