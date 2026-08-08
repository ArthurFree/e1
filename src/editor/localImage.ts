/**
 * 本地图片节点（R004 阶段 6，§6.1）：图片二进制存附件资源存储，
 * 文档 JSON 只保存 attachmentId/alt/width，不再内联 Base64——
 * 避免 Base64 随自动版本快照被重复存储导致 IndexedDB 膨胀。
 *
 * 渲染经 AssetAccessService.resolveUrl（Web：Object URL）即用即毁，
 * 节点销毁时 releaseUrl；加载失败/资源缺失显示占位。
 * 粘贴、拖拽与 `/` 命令三条插入路径统一走
 * File → AssetCommandService.importAsset（含 domain/attachments 校验）→
 * 插入本节点（R005 阶段 5：编辑器不再触碰 alert/input file/Object URL）。
 *
 * 旧 Base64 图片（image 节点 data: URI）继续由 Image 扩展兼容渲染，
 * 编辑器不再产生新的 Base64（Image 的 allowBase64 已关闭，见 extensions.ts）。
 *
 * Markdown 导出与附件块一致：经 R005 阶段 4B 的 portable 序列化输出
 * assets/ 相对路径（plain 模式降级为可见占位文本）。
 */
import { Node } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { isDomainError, isQuotaExceededError } from "../domain/errors";
import { getAssetServices, type AttachmentFileData } from "./attachment";

/** 粘贴/拖拽图片文件的 ProseMirror 插件 key（测试经它取插件断言行为）。 */
export const localImageFilesPluginKey = new PluginKey("localImageFiles");

/** 本地图片节点的属性：仅元数据，二进制本体不进入文档 JSON。 */
export interface LocalImageAttrs {
  attachmentId: string;
  alt?: string | null;
  width?: number | null;
}

/** 从 editor.storage 读取当前文档 ID（由编辑器宿主装配时写入）。 */
function getAttachmentPageId(editor: Editor): string | null {
  return (
    ((editor.storage as unknown as Record<string, unknown>).attachmentPageId as
      string | undefined) ?? null
  );
}

/** 从 FileList 中筛出图片文件（MIME 白名单在插入前由 domain 校验复核）。 */
function imageFiles(files: FileList | null | undefined): File[] {
  return [...(files ?? [])].filter((f) => f.type.startsWith("image/"));
}

/**
 * 校验并写入附件记录后插入本地图片节点；失败时提示且不产生副作用。
 * @returns 是否成功插入。
 */
export async function insertLocalImageData(
  editor: Editor,
  pageId: string,
  file: AttachmentFileData,
  options?: { pos?: number },
): Promise<boolean> {
  const { commands, notify } = getAssetServices(editor);
  let record;
  try {
    record = await commands.importAsset({
      pageId,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      data: file.data,
      requireImage: true,
    });
  } catch (err) {
    // 校验失败（DomainError）/存储空间不足/普通写入失败分开提示（R004 §6.3）。
    notify.notify(
      isDomainError(err)
        ? err.message
        : isQuotaExceededError(err)
          ? "本地存储空间不足，请清理回收站或删除不需要的数据后重试。"
          : `图片「${file.name}」保存失败，未插入。`,
    );
    return false;
  }
  const node = {
    type: "localImage",
    attrs: { attachmentId: record.id, alt: file.name, width: null },
  };
  const chain = editor.chain().focus();
  // 拖拽落地时插入到落点；其余入口插入到当前选区。
  if (options?.pos !== undefined) chain.insertContentAt(options.pos, node);
  else chain.insertContent(node);
  return chain.run();
}

/** File → 字节读出后走统一插入路径（粘贴/拖拽与测试入口保留 File 形参）。 */
export async function insertLocalImageFile(
  editor: Editor,
  pageId: string,
  file: File,
  options?: { pos?: number },
): Promise<boolean> {
  const data = new Uint8Array(await file.arrayBuffer());
  return insertLocalImageData(
    editor,
    pageId,
    { name: file.name, mimeType: file.type, size: file.size, data },
    options,
  );
}

/** 打开文件选择器插入本地图片（`/图片` 命令入口；选文件经 AssetPicker）。 */
export function pickAndInsertLocalImage(editor: Editor, pageId: string) {
  const { picker } = getAssetServices(editor);
  void picker
    .pick({ accept: "image/png,image/jpeg,image/gif,image/webp,image/svg+xml" })
    .then((picked) => {
      if (picked) void insertLocalImageData(editor, pageId, picked);
    });
}

/**
 * 本地图片块：文档节点只保存 attachmentId/alt/width；
 * 渲染经 access.resolveUrl 取临时 URL，destroy 时 releaseUrl 释放。
 */
export const LocalImage = Node.create({
  name: "localImage",
  group: "block",
  // atom：节点无内部可编辑内容，作为整体叶子参与选区与删除。
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      attachmentId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-attachment-id"),
      },
      alt: { default: null },
      width: {
        default: null,
        parseHTML: (element) => {
          const raw = element.getAttribute("width");
          const parsed = raw ? Number(raw) : NaN;
          return Number.isFinite(parsed) ? parsed : null;
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: "img[data-local-image]" }];
  },

  renderHTML({ node }) {
    // 静态序列化（编辑器内复制粘贴/HTML 导出）不含 src：可渲染 URL 只能异步
    // 解析；以 data-local-image + data-attachment-id 保证粘贴回编辑器可还原。
    return [
      "img",
      {
        "data-local-image": "",
        "data-attachment-id": node.attrs.attachmentId,
        alt: node.attrs.alt,
        width: node.attrs.width,
      },
    ];
  },

  addNodeView() {
    return ({ node, editor }) => {
      const dom = document.createElement("div");
      dom.className = "local-image";
      dom.contentEditable = "false";

      const img = document.createElement("img");
      img.className = "local-image__img";
      img.draggable = false;

      const placeholder = document.createElement("div");
      placeholder.className = "local-image__placeholder";
      placeholder.textContent = "图片加载中…";

      dom.append(placeholder);

      let resolvedUrl: string | null = null;
      const releaseUrl = () => {
        if (resolvedUrl) {
          getAssetServices(editor).access.releaseUrl(resolvedUrl);
          resolvedUrl = null;
        }
      };

      const showMissing = () => {
        releaseUrl();
        img.remove();
        if (!placeholder.isConnected) dom.append(placeholder);
        placeholder.textContent = "图片不可用";
        dom.classList.add("local-image--missing");
      };

      const load = async (attachmentId: string) => {
        releaseUrl();
        // 服务未装配或解析失败都按「图片不可用」降级，不产生未捕获异常。
        const url = await (async () => {
          try {
            return await getAssetServices(editor).access.resolveUrl(
              attachmentId,
            );
          } catch {
            return null;
          }
        })();
        if (!url) {
          // 资源缺失或为空：显示占位，节点可手动删除（与附件块同语义）。
          showMissing();
          return;
        }
        resolvedUrl = url;
        img.src = url;
        placeholder.remove();
        if (!img.isConnected) dom.append(img);
        dom.classList.remove("local-image--missing");
      };

      const sync = () => {
        img.alt = (node.attrs.alt as string | null) ?? "";
        const width = node.attrs.width as number | null;
        img.style.width = width ? `${width}px` : "";
      };
      sync();
      void load(node.attrs.attachmentId as string);

      return {
        dom,
        update(updated) {
          if (updated.type.name !== node.type.name) return false;
          const prevAttachmentId = node.attrs.attachmentId as string;
          node = updated;
          sync();
          if ((updated.attrs.attachmentId as string) !== prevAttachmentId) {
            void load(updated.attrs.attachmentId as string);
          }
          return true;
        },
        destroy() {
          // 节点销毁时释放临时 URL，避免句柄泄漏（即用即毁）。
          releaseUrl();
        },
      };
    };
  },

  addProseMirrorPlugins() {
    // 粘贴/拖拽图片文件统一走附件化插入（与 `/图片` 命令同一路径）。
    // 箭头函数捕获扩展的 this（editor），避免 this 别名。
    return [
      new Plugin({
        key: localImageFilesPluginKey,
        props: {
          handlePaste: (_view, event) => {
            const files = imageFiles(event.clipboardData?.files);
            if (files.length === 0) return false;
            const pageId = getAttachmentPageId(this.editor);
            if (!pageId) return false;
            event.preventDefault();
            for (const file of files) {
              void insertLocalImageFile(this.editor, pageId, file);
            }
            return true;
          },
          handleDrop: (view, event) => {
            const files = imageFiles(event.dataTransfer?.files);
            if (files.length === 0) return false;
            const pageId = getAttachmentPageId(this.editor);
            if (!pageId) return false;
            event.preventDefault();
            // 插入到落点；jsdom 等无布局环境取不到坐标时退化为当前选区。
            const pos = view.posAtCoords({
              left: event.clientX,
              top: event.clientY,
            })?.pos;
            for (const file of files) {
              void insertLocalImageFile(this.editor, pageId, file, {
                pos,
              });
            }
            return true;
          },
        },
      }),
    ];
  },
});
