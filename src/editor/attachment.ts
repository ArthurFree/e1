import { Node } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { attachmentRepository } from "../infrastructure/repositories";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export interface AttachmentAttrs {
  attachmentId: string;
  name: string;
  mimeType: string;
  size: number;
}

/** 校验并写入附件记录后插入附件节点；超限立即提示且不写 IndexedDB。 */
export async function insertAttachmentFile(
  editor: Editor,
  pageId: string,
  file: File,
): Promise<boolean> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    window.alert(`附件「${file.name}」超过 20MB 上限，未保存。`);
    return false;
  }
  let record;
  try {
    record = await attachmentRepository.add({
      pageId,
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      blob: file,
    });
  } catch {
    // 存储空间不足等写入失败：提示并中止，不产生孤儿节点。
    window.alert(`附件「${file.name}」保存失败，可能是存储空间不足，请释放空间后重试。`);
    return false;
  }
  editor
    .chain()
    .focus()
    .insertContent({
      type: "attachment",
      attrs: {
        attachmentId: record.id,
        name: record.name,
        mimeType: record.mimeType,
        size: record.size,
      },
    })
    .run();
  return true;
}

/** 打开文件选择器插入附件。 */
export function pickAndInsertAttachment(editor: Editor, pageId: string) {
  const input = document.createElement("input");
  input.type = "file";
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) void insertAttachmentFile(editor, pageId, file);
  };
  input.click();
}

/** 从文档 JSON 中收集被引用的附件 ID（孤儿清理用）。 */
export function collectAttachmentIds(doc: unknown): string[] {
  const ids: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const record = node as { type?: string; attrs?: Record<string, unknown>; content?: unknown[] };
    if (record.type === "attachment" && typeof record.attrs?.attachmentId === "string") {
      ids.push(record.attrs.attachmentId);
    }
    for (const child of record.content ?? []) walk(child);
  };
  walk(doc);
  return ids;
}

/**
 * 附件块：文档节点只保存附件 ID、名称、类型与大小；
 * Blob 存 attachments store，下载走本地 Blob URL 并及时释放。
 */
export const Attachment = Node.create({
  name: "attachment",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      attachmentId: { default: null },
      name: { default: "" },
      mimeType: { default: "application/octet-stream" },
      size: { default: 0 },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-attachment-id]" }];
  },

  renderHTML({ node }) {
    return [
      "div",
      {
        "data-attachment-id": node.attrs.attachmentId,
        "data-name": node.attrs.name,
        "data-mime-type": node.attrs.mimeType,
        "data-size": node.attrs.size,
      },
      node.attrs.name,
    ];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("div");
      dom.className = "attachment-block";
      dom.contentEditable = "false";

      const icon = document.createElement("span");
      icon.className = "attachment-block__icon";
      icon.textContent = "📎";

      const info = document.createElement("span");
      info.className = "attachment-block__info";
      const name = document.createElement("span");
      name.className = "attachment-block__name";
      const meta = document.createElement("span");
      meta.className = "attachment-block__meta";
      info.append(name, meta);

      const status = document.createElement("span");
      status.className = "attachment-block__status";

      const download = document.createElement("button");
      download.type = "button";
      download.className = "attachment-block__action";
      download.textContent = "下载";
      download.setAttribute("aria-label", `下载附件 ${node.attrs.name as string}`);
      download.addEventListener("click", () => {
        void (async () => {
          status.textContent = "";
          const record = await attachmentRepository
            .get(node.attrs.attachmentId as string)
            .catch(() => undefined);
          if (!record || !(record.blob instanceof Blob) || record.blob.size === 0) {
            // Blob 缺失或损坏：提示“附件不可用”，节点可手动移除。
            status.textContent = "附件不可用";
            return;
          }
          const url = URL.createObjectURL(record.blob);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = record.name;
          anchor.click();
          URL.revokeObjectURL(url);
        })();
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "attachment-block__action";
      remove.textContent = "移除";
      remove.setAttribute("aria-label", `移除附件 ${node.attrs.name as string}`);
      remove.addEventListener("click", () => {
        const pos = typeof getPos === "function" ? getPos() : null;
        if (pos === null || pos === undefined) return;
        // 仅删除文档引用；附件记录的孤儿清理在保存后执行。
        editor
          .chain()
          .focus()
          .deleteRange({ from: pos, to: pos + node.nodeSize })
          .run();
      });

      const sync = () => {
        name.textContent = (node.attrs.name as string) || "未命名附件";
        meta.textContent = `${node.attrs.mimeType} · ${formatBytes(node.attrs.size as number)}`;
      };
      sync();

      dom.append(icon, info, status, download, remove);
      return {
        dom,
        update(updated) {
          if (updated.type.name !== node.type.name) return false;
          node = updated;
          sync();
          return true;
        },
      };
    };
  },
});
