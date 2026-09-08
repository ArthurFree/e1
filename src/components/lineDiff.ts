/**
 * R012 Stage 5（需求 §27 Diff）：行级文本 diff 纯函数。
 *
 * 语义：
 * - 输入为两段纯文本（历史版本 vs 当前正文；Desktop 两侧均为 raw
 *   Markdown body），按行对齐输出 added/removed/context 序列；
 * - 算法为标准 LCS（后缀 DP + 回溯），先做公共前缀/后缀裁剪缩小
 *   DP 规模；等长选择时优先 removed（展示上先删后增，符合 diff 惯例）；
 * - 不做富文本 semantic diff，不做词级高亮（§27 明确不做）；
 * - 行数过大（两边合计超过 DIFF_MAX_TOTAL_LINES）返回 null，
 *   由 UI 降级提示「文档过大，无法比较」——防止 O(n×m) DP 卡顿。
 */

/** diff 行：added=仅当前有，removed=仅历史有，context=两侧共有。 */
export interface RevisionDiffLine {
  type: "added" | "removed" | "context";
  text: string;
}

/** 行数上限（两边合计）：超过时 computeLineDiff 返回 null。 */
export const DIFF_MAX_TOTAL_LINES = 8000;

/**
 * 计算 before → after 的行级 diff。
 * 返回 null 表示输入过大，调用方应降级为提示而不是渲染 diff。
 */
export function computeLineDiff(
  before: string,
  after: string,
): RevisionDiffLine[] | null {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length + b.length > DIFF_MAX_TOTAL_LINES) return null;

  // 公共前缀/后缀裁剪：典型编辑只动局部，DP 规模随之大幅缩小。
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const mid = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const lines: RevisionDiffLine[] = [];
  for (let i = 0; i < prefix; i += 1) {
    lines.push({ type: "context", text: a[i] });
  }
  lines.push(...lcsDiff(mid, midB));
  for (let i = a.length - suffix; i < a.length; i += 1) {
    lines.push({ type: "context", text: a[i] });
  }
  return lines;
}

/**
 * 中段 LCS 行 diff：后缀 DP 表（Uint16 足够——LCS 长度 ≤ 行数上限）
 * + 回溯。相等取 context；否则优先 removed（先删后增）。
 */
function lcsDiff(a: string[], b: string[]): RevisionDiffLine[] {
  const m = a.length;
  const n = b.length;
  const width = n + 1;
  // dp[i*width + j] = a[i:] 与 b[j:] 的 LCS 长度。
  const dp = new Uint16Array((m + 1) * width);
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const lines: RevisionDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      lines.push({ type: "context", text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      lines.push({ type: "removed", text: a[i] });
      i += 1;
    } else {
      lines.push({ type: "added", text: b[j] });
      j += 1;
    }
  }
  for (; i < m; i += 1) lines.push({ type: "removed", text: a[i] });
  for (; j < n; j += 1) lines.push({ type: "added", text: b[j] });
  return lines;
}
