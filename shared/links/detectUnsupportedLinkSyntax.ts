/**
 * R011 / R014：兼容性探测器——受影响文档若含 Wiki 链接则 warning。
 * 引用式链接（`[a][id]` / `[id]: dest`）R014 已纳入改写，不再告警。
 */
export interface MarkdownCompatibilityWarning {
  code: "UNSUPPORTED_WIKI_LINK";
  message: string;
}

/**
 * 轻量扫描：围栏外出现 `[[` 时告警。
 * 故意保守：宁可多报，不静默漏报。
 */
export function detectUnsupportedLinkSyntax(
  markdown: string,
): MarkdownCompatibilityWarning[] {
  const body = markdown.replace(/\r\n/g, "\n");
  const warnings: MarkdownCompatibilityWarning[] = [];
  let inFence = false;
  const FENCE = /^\s*(```|~~~)/;
  let hasWiki = false;

  for (const line of body.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // 行内代码粗屏蔽：去掉 `...` 再检测。
    const masked = line.replace(/`[^`\n]*`/g, "");
    if (!hasWiki && masked.includes("[[")) {
      hasWiki = true;
    }
  }

  if (hasWiki) {
    warnings.push({
      code: "UNSUPPORTED_WIKI_LINK",
      message: "文档含 Wiki 链接（[[…]]），本次操作不会自动改写该形态。",
    });
  }
  return warnings;
}
