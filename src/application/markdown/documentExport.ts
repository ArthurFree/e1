/**
 * 文档级 Markdown 导出编排（R005 阶段 4，批次 4B）。
 *
 * 修复「Markdown 导出静默丢弃 localImage/attachment」的现状
 *（markdown-compatibility.md §重点）：
 * - 文档含图片/附件时：经 MarkdownCodec portable 模式序列化，
 *   资源路径由 prepareExportAssets 一次性确定性确定（assets/<文件名>），
 *   产物为 ZIP 字节流（<标题>.md + assets/…）；
 * - 无资源引用时：维持单 Markdown 文件导出（codec plain 模式，
 *   metadata 为空 → 无 Frontmatter，保持既有导出行为）；
 * - 附件记录缺失（服务查不到）：对应节点降级为可见占位文本并计入
 *   unsupported（missing-asset），不中断导出。
 *
 * 调用方（MainArea 导出按钮）负责把结果触发为浏览器下载
 * （a[download] + createObjectURL）；附件资源下载已收口到
 * AssetAccessService（R005 阶段 5），文档导出下载的平台化收口在阶段 8。
 * 本层只依赖 domain port 与 editor codec，不接触 infrastructure。
 */
import type { AssetAccessService } from "../assets/assetServices";
import { createMarkdownCodec } from "../../editor/markdown/codec";
import type {
  MarkdownAssetResolver,
  UnsupportedMarkdownFeature,
} from "../../editor/markdown/types";
import { createZip } from "../services/zip";
import {
  collectDocumentAssetRefs,
  missingAssetUnsupported,
  prepareExportAssets,
  sanitizeFileName,
  type DocumentAssetRef,
} from "./assetResolver";

const encoder = new TextEncoder();

interface JsonNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
}

/** plain 模式不调用 resolver（资源节点走占位降级），提供防御性实现即可。 */
const noopResolver: MarkdownAssetResolver = {
  resolveAssetPath: ({ name }) => `assets/${name}`,
};

/**
 * 把缺失附件的 localImage/attachment 节点替换为可见占位段落
 *（与 editor/markdown/serialize.ts 的 plain 降级文案保持一致）。
 * R005 阶段 7A 起导出供 Vault 导出服务复用。
 */
export function replaceMissingAssetNodes(
  document: unknown,
  missingIds: ReadonlySet<string>,
): unknown {
  const transform = (node: JsonNode): JsonNode => {
    if (!node || typeof node !== "object") return node;
    if (node.type === "localImage" || node.type === "attachment") {
      const attrs = node.attrs ?? {};
      const attachmentId =
        typeof attrs.attachmentId === "string" ? attrs.attachmentId : "";
      if (attachmentId && missingIds.has(attachmentId)) {
        const label =
          node.type === "localImage"
            ? typeof attrs.alt === "string" && attrs.alt
              ? attrs.alt
              : "本地图片"
            : typeof attrs.name === "string" && attrs.name
              ? attrs.name
              : "附件";
        const prefix = node.type === "localImage" ? "图片" : "附件";
        return {
          type: "paragraph",
          content: [{ type: "text", text: `（${prefix}：${label}）` }],
        };
      }
    }
    if (!Array.isArray(node.content)) return { ...node };
    return { ...node, content: node.content.map((child) => transform(child)) };
  };
  return transform(document as JsonNode);
}

export interface DocumentExportInput {
  /** 页面标题（用作导出文件名；为空时回退「无标题」）。 */
  title: string;
  /** 编辑器当前文档 JSON。 */
  document: unknown;
  /** 资源访问服务（R005 阶段 5；经 AppServices.assets.access 注入）。 */
  assetAccess: AssetAccessService;
}

interface DocumentExportBase {
  /** true 表示发生了有损转换（含资源缺失降级），细节见 unsupported。 */
  lossy: boolean;
  unsupported: UnsupportedMarkdownFeature[];
}

/** 无资源引用：单 Markdown 文件导出（维持既有行为）。 */
export interface MarkdownFileExport extends DocumentExportBase {
  kind: "markdown";
  /** 建议下载文件名（`<标题>.md`）。 */
  fileName: string;
  markdown: string;
}

/** 含图片/附件：ZIP 包导出（`<标题>.md` + `assets/…`）。 */
export interface ZipArchiveExport extends DocumentExportBase {
  kind: "zip";
  /** 建议下载文件名（`<标题>.zip`）。 */
  fileName: string;
  /** ZIP 字节流（调用方包成 Blob 触发下载）。 */
  data: Uint8Array;
  /** 包内条目名（诊断/测试用）。 */
  entryNames: string[];
  /** 随包写出的资源文件数。 */
  assetCount: number;
}

export type DocumentExportResult = MarkdownFileExport | ZipArchiveExport;

/**
 * 导出当前文档为 Markdown（必要时含资源 ZIP）。
 * 导出内容经 codec 白名单语义序列化；有损转换逐条记入 unsupported。
 */
export async function exportDocumentMarkdown(
  input: DocumentExportInput,
): Promise<DocumentExportResult> {
  const codec = createMarkdownCodec();
  const title = input.title.trim() || "无标题";
  // ZIP 条目名不允许目录分隔符，下载文件名同步使用净化结果。
  const safeTitle = sanitizeFileName(title, "无标题");

  const refs = collectDocumentAssetRefs(input.document);

  // —— 无资源引用：单 md 导出（plain 模式、无 Frontmatter，维持现状） ——
  if (refs.length === 0) {
    const result = await codec.serialize({
      document: input.document,
      metadata: {},
      assetResolver: noopResolver,
      mode: "plain",
    });
    return {
      kind: "markdown",
      fileName: `${safeTitle}.md`,
      markdown: result.markdown,
      lossy: result.lossy,
      unsupported: result.unsupported,
    };
  }

  // —— 含资源引用：portable 序列化 + ZIP 打包 ——
  const prepared = await prepareExportAssets(refs, input.assetAccess);
  const missingIds = new Set(prepared.missing.map((ref) => ref.attachmentId));
  const document =
    missingIds.size > 0
      ? replaceMissingAssetNodes(input.document, missingIds)
      : input.document;

  const result = await codec.serialize({
    document,
    metadata: {},
    assetResolver: prepared.resolver,
    mode: "portable",
  });

  const mdEntryName = `${safeTitle}.md`;
  const zipEntries = [
    { name: mdEntryName, data: encoder.encode(result.markdown) },
    ...prepared.files.map((file) => ({ name: file.path, data: file.data })),
  ];
  const missingUnsupported = prepared.missing.map((ref: DocumentAssetRef) =>
    missingAssetUnsupported(ref),
  );

  return {
    kind: "zip",
    fileName: `${safeTitle}.zip`,
    data: createZip(zipEntries),
    entryNames: zipEntries.map((entry) => entry.name),
    assetCount: prepared.files.length,
    lossy: result.lossy || missingUnsupported.length > 0,
    unsupported: [...missingUnsupported, ...result.unsupported],
  };
}
