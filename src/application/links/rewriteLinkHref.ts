/**
 * 失效链接重写（R010 Stage 6 §14）：把文档 JSON 中 href 精确等于
 * oldHref 的 link mark 全部改写为 newHref。
 *
 * 确定性语义：
 * - 匹配条件是 mark.attrs.href 与 oldHref 完全相等——索引侧的
 *   DocumentLink 按 href 聚类，区分不出同一 href 的第几处出现，
 *   逐处确认成本高且易错，因此同一 href 的所有出现整体重写；
 * - 只改 link mark 的 href，链接文本、其他 mark 与文档结构一律不动；
 * - internalLink/mention 节点引用（attrs.id 形态，href 恒为 ""）不在
 *   本函数射程内，由调用方在入参层拒绝；
 * - 输入不被修改：不可变拷贝，仅重建命中分支（与
 *   editor/markdown/serialize.ts 的变换风格一致）。
 */

interface WalkNode {
  type?: string;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  content?: WalkNode[];
  [key: string]: unknown;
}

export interface LinkRewriteResult {
  /** 重写后的文档 JSON；无命中时与原输入引用相等。 */
  document: unknown;
  /** 命中的 link mark 数量。 */
  rewritten: number;
}

/** 重写文档 JSON 中全部 href === oldHref 的 link mark。 */
export function rewriteLinkHref(
  contentJson: unknown,
  oldHref: string,
  newHref: string,
): LinkRewriteResult {
  let rewritten = 0;

  const walk = (node: WalkNode): WalkNode => {
    if (!node || typeof node !== "object") return node;
    let next = node;

    if (Array.isArray(node.marks)) {
      let marksChanged = false;
      const marks = node.marks.map((mark) => {
        if (mark.type === "link" && mark.attrs?.href === oldHref) {
          rewritten += 1;
          marksChanged = true;
          return { ...mark, attrs: { ...mark.attrs, href: newHref } };
        }
        return mark;
      });
      if (marksChanged) next = { ...next, marks };
    }

    if (Array.isArray(node.content)) {
      let childrenChanged = false;
      const content = node.content.map((child) => {
        const walked = walk(child);
        if (walked !== child) childrenChanged = true;
        return walked;
      });
      if (childrenChanged) next = { ...next, content };
    }

    return next;
  };

  const document = walk(contentJson as WalkNode);
  return { document, rewritten };
}
