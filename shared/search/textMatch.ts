/**
 * R008 Stage 3（§10.6/§11.4）：全文搜索的文本归一与匹配规则——
 * 环境中立、零依赖，Renderer（内存参照实现）与 Electron Main
 *（SQLite 实现，R008 Stage 4）共用同一语义，契约套件据此冻结行为。
 *
 * 归一：NFKC + lowercase（大小写默认不敏感，§10.6）。
 *
 * 索引词元（tokenizeForIndex）：
 * - CJK 连续段（汉字）：单字 unigram + 相邻 bigram——SQLite FTS5 无法做
 *   子串匹配，bigram 覆盖是中文检索的应用层方案（§11.4 方案 B，
 *   不引入 SQLite extension）；
 * - 拉丁/数字连续段：整词一个词元（body 匹配为词前缀语义）；
 * - 其余可见字符（emoji 等）：单字 unigram。
 *
 * body 命中（bodyMatches）：查询按空白切词，逐项判定——含 CJK 的项
 * 要求其 unigram/bigram 全部被文档词元覆盖（长度 ≥2 时等价于子串），
 * 拉丁项要求存在以其为前缀的文档词。所有项命中（AND）才算 body 命中。
 *
 * title/tag 命中：归一化原文的子串匹配（与既有搜索 UX 一致）。
 */

/** CJK 统一表意文字（基本区 + 扩展 A + 兼容区）。 */
const CJK = /[㐀-䶿一-鿿豈-﫿]/u;
const LATIN_CHAR = /[a-z0-9_+\-]/;
const WORD_CHAR_RUN = /[a-z0-9_+\-]+/g;

/** 归一化：NFKC + 小写（查询与索引两侧同规则）。 */
export function normalizeSearchText(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/** 索引词元集：CJK unigram+bigram、拉丁整词、其他可见字符 unigram。 */
export function tokenizeForIndex(text: string): Set<string> {
  const tokens = new Set<string>();
  const normalized = normalizeSearchText(text);
  let cjkRun: string[] = [];
  let latinRun = "";
  const flushCjk = () => {
    for (const ch of cjkRun) tokens.add(ch);
    for (let i = 0; i + 1 < cjkRun.length; i += 1) {
      tokens.add(cjkRun[i] + cjkRun[i + 1]);
    }
    cjkRun = [];
  };
  const flushLatin = () => {
    if (latinRun) tokens.add(latinRun);
    latinRun = "";
  };
  for (const ch of normalized) {
    if (CJK.test(ch)) {
      flushLatin();
      cjkRun.push(ch);
    } else if (LATIN_CHAR.test(ch)) {
      flushCjk();
      latinRun += ch;
    } else {
      flushCjk();
      flushLatin();
      if (!/\s/.test(ch)) tokens.add(ch);
    }
  }
  flushCjk();
  flushLatin();
  return tokens;
}

/** 查询切词：归一化后按空白拆分（去重，保留原始项，不做词元化）。 */
export function splitQueryTerms(query: string): string[] {
  const normalized = normalizeSearchText(query.trim());
  if (normalized === "") return [];
  return [...new Set(normalized.split(/\s+/))];
}

/** 单个查询项的 body 命中判定（CJK 覆盖 / 拉丁词前缀）。 */
export function bodyTermMatch(term: string, bodyTokens: Set<string>): boolean {
  let hasCjk = false;
  for (const ch of term) {
    if (CJK.test(ch)) {
      hasCjk = true;
      break;
    }
  }
  if (hasCjk) {
    // 与索引同规则词元化后要求全覆盖（长度 ≥2 的 CJK 项等价于子串）。
    for (const token of tokenizeForIndex(term)) {
      if (!bodyTokens.has(token)) return false;
    }
    return true;
  }
  // 拉丁项：存在以其为前缀的文档词。
  for (const token of bodyTokens) {
    if (token.startsWith(term)) return true;
  }
  return false;
}

/** body 命中：所有查询项均命中（AND）；空查询返回 false（调用方短路）。 */
export function bodyMatches(terms: string[], bodyTokens: Set<string>): boolean {
  if (terms.length === 0) return false;
  return terms.every((term) => bodyTermMatch(term, bodyTokens));
}

/** title/tag 命中：归一化子串。 */
export function fieldMatches(
  normalizedField: string,
  normalizedQuery: string,
): boolean {
  return normalizedQuery !== "" && normalizedField.includes(normalizedQuery);
}

/** snippet 截取半径（命中点前后字符数）。 */
const SNIPPET_RADIUS = 40;
/**
 * 纯文本 snippet：命中点前后各 SNIPPET_RADIUS 字符，首尾省略号。
 * 只返回纯文本（§14.2：DB 不返回 HTML）；body 未命中返回 null。
 */
export function makeTextSnippet(
  bodyText: string,
  query: string,
): string | null {
  const terms = splitQueryTerms(query);
  if (terms.length === 0) return null;
  const haystack = normalizeSearchText(bodyText);
  let hit = -1;
  let hitLength = 0;
  for (const term of terms) {
    // CJK 项（或可整串命中的项）：直接子串定位。
    const direct = haystack.indexOf(term);
    if (direct >= 0) {
      hit = direct;
      hitLength = term.length;
      break;
    }
    // 拉丁前缀命中：扫描词起点，定位以查询项为前缀的词。
    WORD_CHAR_RUN.lastIndex = 0;
    for (const match of haystack.matchAll(WORD_CHAR_RUN)) {
      const word = match[0];
      if (word.startsWith(term) && match.index !== undefined) {
        hit = match.index;
        hitLength = term.length;
        break;
      }
    }
    if (hit >= 0) break;
  }
  if (hit === -1) return null;
  const start = Math.max(0, hit - SNIPPET_RADIUS);
  const end = Math.min(bodyText.length, hit + hitLength + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${bodyText.slice(start, end)}${end < bodyText.length ? "…" : ""}`;
}

/* ------------------------------ 评分与排序（§11.7） ------------------------------ */

/** 命中字段（title > tag > body 优先级）。 */
export type SearchMatchField = "title" | "tag" | "body";

/** §10.6：limit 上限 / 缺省值。 */
export const MAX_SEARCH_LIMIT = 100;
export const DEFAULT_SEARCH_LIMIT = 50;

/** §11.7 评分表（契约套件锁定）。 */
export const SEARCH_SCORE = {
  titleExact: 100,
  titlePrefix: 80,
  titleContains: 60,
  tagMatch: 40,
  bodyMatch: 20,
} as const;

/** 单文档评分输入（归一化字段 + body 词元 + snippet 用原文）。 */
export interface ScoreDocumentInput {
  title: string;
  titleNormalized: string;
  tagsNormalized: string[];
  bodyTokens: Set<string>;
  bodyText: string;
}

export interface ScoreDocumentResult {
  matchedField: SearchMatchField;
  snippet: string | null;
  score: number;
}

/**
 * 按冻结评分表给单条文档打分（exact title 100 > prefix 80 > contains 60
 * > tag 40 > body 20）；未命中返回 null。内存与 SQLite 实现共用本函数，
 * 保证两实现评分语义逐点一致（契约套件锁定）。
 */
export function scoreDocument(
  input: ScoreDocumentInput,
  query: string,
): ScoreDocumentResult | null {
  const normalized = normalizeSearchText(query.trim());
  if (normalized === "") return null;
  const { titleNormalized, tagsNormalized, bodyTokens, bodyText } = input;
  if (titleNormalized === normalized) {
    return {
      matchedField: "title",
      snippet: null,
      score: SEARCH_SCORE.titleExact,
    };
  }
  if (titleNormalized.startsWith(normalized)) {
    return {
      matchedField: "title",
      snippet: null,
      score: SEARCH_SCORE.titlePrefix,
    };
  }
  if (fieldMatches(titleNormalized, normalized)) {
    return {
      matchedField: "title",
      snippet: null,
      score: SEARCH_SCORE.titleContains,
    };
  }
  if (tagsNormalized.some((tag) => fieldMatches(tag, normalized))) {
    return { matchedField: "tag", snippet: null, score: SEARCH_SCORE.tagMatch };
  }
  if (bodyMatches(splitQueryTerms(normalized), bodyTokens)) {
    return {
      matchedField: "body",
      snippet: makeTextSnippet(bodyText, normalized),
      score: SEARCH_SCORE.bodyMatch,
    };
  }
  return null;
}

/** 稳定排序：score 降序 → title zh-CN → pageId。 */
export function compareSearchResults<
  T extends { score: number; title: string; pageId: string },
>(a: T, b: T): number {
  if (a.score !== b.score) return b.score - a.score;
  const byTitle = a.title.localeCompare(b.title, "zh-CN");
  if (byTitle !== 0) return byTitle;
  return a.pageId.localeCompare(b.pageId);
}
