/**
 * R010 Stage 2（§10）：保存侧链接提取——从 Tiptap 文档 JSON 提取结构化链接。
 *
 * 环境中立、零依赖（仅依赖 ./linkKind.js 语义核心）。与
 * ./extractMarkdownLinks.js（Main 索引侧从 Markdown 源文本提取）互为
 * 双提取器，输出一致性由 src/editor/markdown/extractLinksConsistency.test.ts
 * 契约测试锁定。
 *
 * 提取规则：
 * - text 节点的 link mark → classifyLinkHref 分类；internal/asset 经
 *   resolveLinkPath 归一到 vault 根（.. 逃逸保持 null，由索引层按 broken 处理）；
 * - internalLink / mention 节点（attrs {id, label}）→ 页面引用：kind 恒为
 *   internal、href 恒为 ""、knownTargetPageId = attrs.id、targetRelativePath
 *   恒为 null（运行时身份，无磁盘路径）；
 * - image / attachment 节点的 src → 同样经 classifyLinkHref 分类（相对路径
 *   即 asset；外部 URL / data: URI 归为 external，是否入索引由索引层裁决）；
 * - 代码块内的 Markdown 样例在 JSON 中只是 code mark 文本，结构上天然
 *   不产生 link mark，无需额外屏蔽。
 *
 * 已知边界（与 Markdown 提取器保持一致的最小公共语义）：
 * - 空 href（含纯空白）不产生条目；
 * - href 首尾空白不裁剪，按原文保留（LINK-01：磁盘原文即真相）；
 * - 同一段落内被内联格式切开的多个 text 节点若带同一 link mark，会按节点
 *   各产出一条（label 为片段），不做跨节点合并——链接目标信息不受影响。
 */
import { classifyLinkHref, resolveLinkPath } from "./linkKind.js";
import type { LinkKind } from "./linkKind.js";

/** 双提取器统一的单条链接输出形态。 */
export interface ExtractedLink {
  /** 原始 href（页面引用类节点无磁盘 href，为 ""）。 */
  href: string;
  /** 链接显示文本（链接文字 / 图片 alt / 附件名 / 引用节点 label）。 */
  label: string;
  kind: LinkKind;
  /** `#anchor` 片段（不含 `#`），无则 null。 */
  fragment: string | null;
  /** internal/asset 归一到 vault 根的 posix 路径；其余或 .. 逃逸为 null。 */
  targetRelativePath: string | null;
  /** 已知目标页面 id（internalLink/mention）；路径链接为 null（索引层解析）。 */
  knownTargetPageId: string | null;
}

/**
 * 双提取器共用的条目构造：分类 + fragment 剥离 + vault 根路径归一。
 * 空 href 返回 null（不产出条目）。
 */
export function buildExtractedLink(
  href: string,
  label: string,
  sourceRelativePath: string,
): ExtractedLink | null {
  if (href.trim() === "") return null;
  const classified = classifyLinkHref(href);
  return {
    href,
    label,
    kind: classified.kind,
    fragment: classified.fragment,
    targetRelativePath:
      classified.kind === "internal" || classified.kind === "asset"
        ? resolveLinkPath(sourceRelativePath, href)
        : null,
    knownTargetPageId: null,
  };
}

interface WalkNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  content?: WalkNode[];
}

/** 从 Tiptap 文档 JSON 提取链接。contentJson 结构非法时尽力遍历、不抛错。 */
export function extractDocumentLinks(
  contentJson: unknown,
  sourceRelativePath: string,
): ExtractedLink[] {
  const links: ExtractedLink[] = [];

  const walk = (node: WalkNode | undefined) => {
    if (!node || typeof node !== "object") return;

    // 页面引用类节点：internalLink（R010 Stage 1）与 mention。
    if (node.type === "internalLink" || node.type === "mention") {
      const id = node.attrs?.id;
      if (typeof id === "string" && id !== "") {
        links.push({
          href: "",
          label: typeof node.attrs?.label === "string" ? node.attrs.label : "",
          kind: "internal",
          fragment: null,
          targetRelativePath: null,
          knownTargetPageId: id,
        });
      }
    }

    // 图片 / 附件节点的 src（相对路径 → asset；外部 URL → external）。
    if (
      (node.type === "image" || node.type === "attachment") &&
      typeof node.attrs?.src === "string"
    ) {
      const alt = node.attrs.alt;
      const name = node.attrs.name;
      const label =
        typeof alt === "string" ? alt : typeof name === "string" ? name : "";
      const link = buildExtractedLink(
        node.attrs.src,
        label,
        sourceRelativePath,
      );
      if (link) links.push(link);
    }

    if (node.type === "text" && Array.isArray(node.marks)) {
      for (const mark of node.marks) {
        if (mark.type !== "link" || typeof mark.attrs?.href !== "string") {
          continue;
        }
        const link = buildExtractedLink(
          mark.attrs.href,
          typeof node.text === "string" ? node.text : "",
          sourceRelativePath,
        );
        if (link) links.push(link);
      }
    }

    for (const child of node.content ?? []) walk(child);
  };
  walk(contentJson as WalkNode);

  return links;
}
