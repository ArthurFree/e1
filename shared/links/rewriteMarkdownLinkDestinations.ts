/**
 * R011 Stage 1：source-preserving Markdown 链接目的地改写。
 * 只替换 destination 字节；保留 label / title / Frontmatter / 代码 / fragment。
 * external / mailto / anchor 永不改写。
 */
import { classifyLinkHref, splitHref } from "./linkKind.js";
import { scanMarkdownLinkDestinations } from "./scanMarkdownLinkDestinations.js";

export interface MarkdownDestinationRewriteRule {
  /** 匹配目的地路径部分（可含或不含 fragment；匹配时忽略 fragment）。 */
  oldHref: string;
  /** 新目的地路径（不含 fragment；fragment 从原文保留）。 */
  newHref: string;
}

function pathKey(href: string): string {
  return splitHref(href).path;
}

/** 空格路径优先写成 `<...>`。 */
export function formatDestination(
  path: string,
  preferAngle: boolean,
): { text: string; wrapper: "bare" | "angle" } {
  if (preferAngle || /[\s()]/.test(path)) {
    return { text: path, wrapper: "angle" };
  }
  return { text: path, wrapper: "bare" };
}

/**
 * 按规则改写 markdown 中的链接/图片目的地。
 * 从文件尾部向前替换，避免 offset 漂移。
 */
export function rewriteMarkdownLinkDestinations(
  markdown: string,
  rules: MarkdownDestinationRewriteRule[],
): { markdown: string; rewrittenCount: number } {
  if (rules.length === 0) {
    return { markdown, rewrittenCount: 0 };
  }

  const normalized = markdown.replace(/\r\n/g, "\n");
  const byOld = new Map<string, string>();
  for (const rule of rules) {
    const kind = classifyLinkHref(rule.oldHref).kind;
    if (kind !== "internal" && kind !== "asset") continue;
    byOld.set(pathKey(rule.oldHref), pathKey(rule.newHref));
  }

  const spans = scanMarkdownLinkDestinations(normalized);
  const ordered = [...spans].sort(
    (a, b) => b.destinationStart - a.destinationStart,
  );

  let result = normalized;
  let rewrittenCount = 0;

  for (const span of ordered) {
    const spanKind = classifyLinkHref(span.href).kind;
    if (spanKind !== "internal" && spanKind !== "asset") continue;

    const { path, fragment } = splitHref(span.href);
    const newPath = byOld.get(path);
    if (newPath === undefined || newPath === path) continue;

    const fragmentSuffix = fragment !== null ? `#${fragment}` : "";
    const preferAngle =
      span.wrapper === "angle" || /[\s()]/.test(newPath + fragmentSuffix);
    const formatted = formatDestination(newPath + fragmentSuffix, preferAngle);

    let replaceStart = span.destinationStart;
    let replaceEnd = span.destinationEnd;
    let replacement = formatted.text;
    if (span.wrapper === "angle") {
      replaceStart -= 1;
      replaceEnd += 1;
      replacement = `<${formatted.text}>`;
    } else if (formatted.wrapper === "angle") {
      replacement = `<${formatted.text}>`;
    }

    result =
      result.slice(0, replaceStart) + replacement + result.slice(replaceEnd);
    rewrittenCount += 1;
  }

  return { markdown: result, rewrittenCount };
}
