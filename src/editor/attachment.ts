/**
 * 附件块扩展（对应 R001 §7.6 附件块）。
 * 文档节点只保存附件元数据（ID/名称/类型/大小），二进制存附件资源存储；
 * 下载经 AssetAccessService（Web：临时 Blob URL + a[download]，即用即毁）。
 * 另有插入、引用收集等工具函数供命令注册表与保存流程使用。
 *
 * 服务注入（R005 阶段 5）：本模块不 import infrastructure，也不再触碰
 * domain 仓储 port 与浏览器 API（alert/input file/Object URL/a[download]
 * 已全部移出）；资源服务组由编辑器宿主（DocumentEditor）写入
 * `editor.storage.assetServices`，经 getAssetServices 读取。
 */
import { Node } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import type { AssetServices } from "../application/assets/assetServices";
import type { AssetImportSource } from "../application/assets/assetServices";
import type { RevealService } from "../application/services/RevealService";
import { isDomainError, isQuotaExceededError } from "../domain/errors";
import { paperclipSvgString } from "../components/ui/icons";

// 单附件上限常量的唯一定义在 domain/attachments（R004 阶段 6 统一校验）；
// 此处 re-export 保持既有引用（测试等）不破坏。
export { MAX_ATTACHMENT_BYTES } from "../domain/attachments";

/** 从 editor.storage 读取资源服务组（由编辑器宿主装配时注入）。 */
export function getAssetServices(editor: Editor): AssetServices {
  const services = (editor.storage as unknown as Record<string, unknown>)
    .assetServices as AssetServices | undefined;
  if (!services) {
    throw new Error("资源服务未装配：editor.storage.assetServices 缺失");
  }
  return services;
}

/**
 * R008 Stage 2（§9.4）：读取可选的 Reveal 服务（编辑器宿主按
 * capabilities.revealInFileManager 门控注入——能力关闭时不注入，
 * 附件块随之不出现「定位」入口；无此服务的运行时天然隐藏）。
 */
export function getRevealService(editor: Editor): RevealService | null {
  const service = (editor.storage as unknown as Record<string, unknown>)
    .revealService as RevealService | null | undefined;
  return service ?? null;
}

/** 字节数的人性化展示（B/KB/MB，一位小数），用于附件块元信息。 */
export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** 附件节点的属性：仅元数据，二进制本体不进入文档 JSON。 */
export interface AttachmentAttrs {
  attachmentId: string;
  name: string;
  mimeType: string;
  size: number;
}

/** 已读出字节或授权引用的待插入文件（File 与 PickedAsset 的统一形状）。 */
export interface AttachmentFileData {
  name: string;
  mimeType: string;
  size: number;
  source: AssetImportSource;
}

/**
 * 校验并写入附件记录后插入附件节点；校验/写入失败立即提示且不写存储。
 * 校验规则（大小/总量/文件名）统一在 domain/attachments，经
 * AssetCommandService.importAsset 执行（R005 阶段 5）。
 * @returns 是否成功插入；失败时已通过 NotificationService 提示用户，
 *   文档与存储均无副作用。
 */
export async function insertAttachmentData(
  editor: Editor,
  pageId: string,
  file: AttachmentFileData,
): Promise<boolean> {
  const { commands, notify } = getAssetServices(editor);
  let record;
  try {
    record = await commands.importAsset({
      pageId,
      name: file.name,
      mimeType: file.mimeType || "application/octet-stream",
      size: file.size,
      source: file.source,
    });
  } catch (err) {
    // 校验失败（DomainError）/存储空间不足/普通写入失败分开提示（R004 §6.3），
    // 不产生孤儿节点。
    notify.notify(
      isDomainError(err)
        ? `${err.message}，未保存。`
        : isQuotaExceededError(err)
          ? "本地存储空间不足，请清理回收站或删除不需要的数据后重试。"
          : `附件「${file.name}」保存失败，请重试。`,
    );
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

/** File → 字节读出后走统一插入路径（粘贴/拖拽与测试入口保留 File 形参）。 */
export async function insertAttachmentFile(
  editor: Editor,
  pageId: string,
  file: File,
): Promise<boolean> {
  const data = new Uint8Array(await file.arrayBuffer());
  return insertAttachmentData(editor, pageId, {
    name: file.name,
    mimeType: file.type,
    size: file.size,
    source: { kind: "bytes", data },
  });
}

/** 打开文件选择器插入附件（选文件经 AssetPicker，编辑器不触碰 input DOM）。 */
export function pickAndInsertAttachment(editor: Editor, pageId: string) {
  const { picker } = getAssetServices(editor);
  void picker.pick().then((picked) => {
    if (picked) void insertAttachmentData(editor, pageId, picked);
  });
}

/** 从文档 JSON 中收集被引用的附件 ID（孤儿清理用）。 */
export function collectAttachmentIds(doc: unknown): string[] {
  const ids: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const record = node as {
      type?: string;
      attrs?: Record<string, unknown>;
      content?: unknown[];
    };
    // 附件块与本地图片（R004 阶段 6）都只以 attachmentId 引用二进制。
    if (
      (record.type === "attachment" || record.type === "localImage") &&
      typeof record.attrs?.attachmentId === "string"
    ) {
      ids.push(record.attrs.attachmentId);
    }
    for (const child of record.content ?? []) walk(child);
  };
  walk(doc);
  return ids;
}

/**
 * 附件块：文档节点只保存附件 ID、名称、类型与大小；
 * 下载经 AssetAccessService.download（Web：临时 Object URL + a[download]）。
 */
export const Attachment = Node.create({
  name: "attachment",
  group: "block",
  // atom：节点无内部可编辑内容，作为整体叶子参与选区与删除。
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
      // 静态 SVG 字符串（无用户输入），与 IconPaperclip 共用同一份路径数据。
      icon.innerHTML = paperclipSvgString(20);

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
      download.setAttribute(
        "aria-label",
        `下载附件 ${node.attrs.name as string}`,
      );
      download.addEventListener("click", () => {
        void (async () => {
          status.textContent = "";
          const ok = await getAssetServices(editor)
            .access.download(node.attrs.attachmentId as string)
            .catch(() => false);
          if (!ok) {
            // 资源缺失或为空：提示“附件不可用”，节点可手动移除。
            status.textContent = "附件不可用";
          }
        })();
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "attachment-block__action";
      remove.textContent = "移除";
      remove.setAttribute(
        "aria-label",
        `移除附件 ${node.attrs.name as string}`,
      );
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

      // R008 Stage 2（§9.4）：附件「在文件管理器中显示」——RevealService 由
      // 宿主按能力门控注入，未注入（Web/能力关闭）时入口不存在。
      const revealService = getRevealService(editor);
      let reveal: HTMLButtonElement | null = null;
      if (revealService) {
        reveal = document.createElement("button");
        reveal.type = "button";
        reveal.className = "attachment-block__action";
        reveal.textContent = "定位";
        reveal.setAttribute(
          "aria-label",
          `在文件管理器中显示附件 ${node.attrs.name as string}`,
        );
        reveal.addEventListener("click", () => {
          void (async () => {
            status.textContent = "";
            const ok = await revealService
              .revealAsset(node.attrs.attachmentId as string)
              .catch(() => false);
            if (!ok) {
              // 与「附件不可用」同级别的就地提示，不泄露任何路径信息。
              status.textContent = "无法定位附件";
            }
          })();
        });
      }

      const sync = () => {
        name.textContent = (node.attrs.name as string) || "未命名附件";
        meta.textContent = `${node.attrs.mimeType} · ${formatBytes(node.attrs.size as number)}`;
      };
      sync();

      dom.append(icon, info, status, download, remove);
      if (reveal) dom.append(reveal);
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
