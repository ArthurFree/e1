/**
 * R011 Stage 1：兼容性探测器——受影响文档若含 Wiki / 引用式链接则 warning。
 * 不改写这些形态（R011 明确不做 Wiki/reference 全量改写）。
 */
export interface MarkdownCompatibilityWarning {
  code: "UNSUPPORTED_WIKI_LINK" | "UNSUPPORTED_REFERENCE_LINK";
  message: string;
}

/**
 * 轻量扫描：围栏外出现 `[[` 或引用定义/引用使用形态时告警。
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
  let hasRef = false;

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
    // 引用定义：`[id]: url`；引用使用：`][id]`（非 `](`）。
    if (
      !hasRef &&
      (/^\s*\[[^\]]+\]:\s+\S/.test(masked) || /\]\[[^\]]+\]/.test(masked))
    ) {
      hasRef = true;
    }
  }

  if (hasWiki) {
    warnings.push({
      code: "UNSUPPORTED_WIKI_LINK",
      message: "文档含 Wiki 链接（[[…]]），本次操作不会自动改写该形态。",
    });
  }
  if (hasRef) {
    warnings.push({
      code: "UNSUPPORTED_REFERENCE_LINK",
      message: "文档含引用式链接，本次操作不会自动改写该形态。",
    });
  }
  return warnings;
}
