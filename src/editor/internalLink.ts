/**
 * 内部页面链接节点（R010 Stage 1）：`@` 插入的页面引用。
 *
 * inline atom，attrs 仅 {id, label}（label 是插入时的标题快照，无重命名
 * 传播，与 mention 同口径）。mention 扩展保留只为渲染存量 mention 节点，
 * 新插入一律为本节点。
 *
 * 持久化（与 mention 同一分支）：
 * - 序列化：portable 模式且 resolveMentionPath 命中 → 标准相对 Markdown
 *   链接 `[label](相对路径)`；否则降级纯文本 `@label`（serialize.ts）；
 * - 解析：codec parse 的可选 resolveInternalLinkTarget 把「相对 .md 链接
 *   且目标能解析到页面 id」的文本链接改写回本节点（codec.ts）。
 *
 * 点击导航：ProseMirror handleClick 插件命中本节点时读取
 * editor.storage.internalLinkServices.onOpenPage（由编辑器宿主注入，
 * 参考 attachment 的 assetServices 先例）；未注入时点击不拦截事件。
 */
import { Node } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/** 内部链接服务组：由编辑器宿主写入 editor.storage.internalLinkServices。 */
export interface InternalLinkServices {
  /** 点击内部链接：打开目标页面（pageId 取节点 attrs.id）。 */
  onOpenPage?: (pageId: string) => void;
}

/** 从 editor.storage 读取内部链接服务组（未装配返回 undefined，不抛错）。 */
export function getInternalLinkServices(
  editor: Editor,
): InternalLinkServices | undefined {
  return (editor.storage as unknown as Record<string, unknown>)
    .internalLinkServices as InternalLinkServices | undefined;
}

/** internalLink 节点的属性。 */
export interface InternalLinkAttrs {
  /** 目标页面 id。 */
  id: string;
  /** 显示文本（插入时的页面标题快照）。 */
  label: string;
}

export const InternalLink = Node.create({
  name: "internalLink",
  group: "inline",
  inline: true,
  // atom：节点无内部可编辑内容，作为整体叶子参与选区与删除。
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      id: { default: null },
      label: { default: "" },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span.internal-link[data-id]",
        getAttrs: (element) => ({
          id: element.getAttribute("data-id"),
          // data-label 供剪贴板 HTML 往返保留显示文本；缺失时取元素文本。
          label:
            element.getAttribute("data-label") ?? element.textContent ?? "",
        }),
      },
    ];
  },

  renderHTML({ node }) {
    const id = node.attrs.id as string;
    const label = node.attrs.label as string;
    return [
      "span",
      { class: "internal-link", "data-id": id, "data-label": label },
      label || id,
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("internalLinkClick"),
        props: {
          handleClick: (view, pos) => {
            const $pos = view.state.doc.resolve(pos);
            // 点击落点可能在 atom 节点前后两侧边界，两边都检查。
            const hit = [$pos.nodeAfter, $pos.nodeBefore].find(
              (node) => node?.type.name === "internalLink",
            );
            const id =
              typeof hit?.attrs.id === "string" ? (hit.attrs.id as string) : "";
            if (!id) return false;
            const onOpenPage = getInternalLinkServices(this.editor)?.onOpenPage;
            // 未注入导航回调时不拦截，保持默认选区行为。
            if (!onOpenPage) return false;
            onOpenPage(id);
            return true;
          },
        },
      }),
    ];
  },
});
