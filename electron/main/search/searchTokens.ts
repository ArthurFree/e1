/**
 * 应用层搜索分词（R008 Stage 4 §11.4，中文方案 B 终选）：为 FTS5 召回
 * 生成 normalized bigram/unigram token 流，与底层分词器解耦——FTS 只
 * 负责候选召回，精确打分与稳定排序由契约层 rankSearchDocuments
 * （shared/search/ranking.ts）完成。
 *
 * 召回完备性论证（契约语义 = 归一化子串匹配）：
 * 归一化查询 Q 若是某文档 title/tags/body 归一化文本的子串，则 Q 的每个
 * \p{L}\p{N} 连续段完整落在文档同一字段的某个连续段内：
 * - 段长 ≥ 2：文档索引侧含该段的全部 bigram，查询侧以这些 bigram AND
 *   召回 → 必命中；
 * - 段长 = 1：文档索引侧含该 unigram → 必命中。
 * 反向不保证（不同段可散落命中）——多余候选由契约层精排过滤，Port 语义
 * 不变。纯 emoji/标点等不产生 \p{L}\p{N} token 的查询由调用方回退
 * instr 子串召回（FTS unicode61 不索引这类字符）。
 *
 * 索引体积为代价（每字符约 1 unigram + 1 bigram，去重后存储）——索引是
 * 派生数据可随时重建，按 Stage 3 结论接受。
 */

/** FTS token 可用字符：Unicode 字母或数字（emoji/标点为分段符）。 */
const TOKEN_CHAR = /[\p{L}\p{N}]/u;

/**
 * 归一化：JS 小写化（Unicode 安全），与契约层 normalizeSearchQuery 的
 * 小写口径一致（trim 由查询侧另行处理）。
 */
export function normalizeSearchText(text: string): string {
  return text.toLowerCase();
}

/** 提取 \p{L}\p{N} 连续段（按码点迭代，代理对安全）。 */
function runsOf(text: string): string[] {
  const runs: string[] = [];
  let current = "";
  for (const ch of text) {
    if (TOKEN_CHAR.test(ch)) {
      current += ch;
    } else if (current !== "") {
      runs.push(current);
      current = "";
    }
  }
  if (current !== "") runs.push(current);
  return runs;
}

/**
 * 索引侧 token 流：每段发出全部 unigram + 重叠 bigram（集合去重）。
 * 输入为 title/tags/body 拼接文本；输出供 FTS5 建索引。
 */
export function tokenizeForSearchIndex(text: string): string[] {
  const tokens = new Set<string>();
  for (const run of runsOf(normalizeSearchText(text))) {
    const chars = [...run];
    for (let i = 0; i < chars.length; i++) {
      tokens.add(chars[i]);
      if (i + 1 < chars.length) tokens.add(chars[i] + chars[i + 1]);
    }
  }
  return [...tokens];
}

/**
 * 查询侧 token：单字符段发 unigram，≥2 字符段发全部重叠 bigram
 * （FTS AND 召回）。normalizedQuery 必须已经归一化（trim + 小写）。
 * 返回空数组表示该查询无法经 FTS 召回（调用方回退 instr 子串召回）。
 */
export function tokenizeForSearchQuery(normalizedQuery: string): string[] {
  const tokens: string[] = [];
  for (const run of runsOf(normalizedQuery)) {
    const chars = [...run];
    if (chars.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i + 1 < chars.length; i++) {
      tokens.push(chars[i] + chars[i + 1]);
    }
  }
  return tokens;
}
