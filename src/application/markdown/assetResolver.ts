/**
 * 导出资源路径解析器（R005 阶段 4，批次 4B；阶段 5 起经 AssetAccessService
 * 读取资源，不再依赖 AttachmentRepository/Blob）。
 *
 * 实现 editor/markdown 的 `MarkdownAssetResolver` 接口：输入文档 JSON 中的
 * localImage/attachment 引用与资源记录，输出 portable
 * 相对路径（`assets/<确定性文件名>`）与对应的二进制文件清单。
 *
 * 确定性规则（portable-vault.md §文件名冲突）：
 * - 全部资源路径先整体确定，再交给 codec 序列化——不边写边猜；
 * - 文件名以附件记录 name 为准（记录缺失时回退节点上的 alt/name）；
 * - 同名冲突按 `name.ext`、`name (2).ext`、`name (3).ext` 递增；
 * - 同一 attachmentId 被多次引用时共用同一路径（文档顺序去重）。
 *
 * 缺失附件（查不到记录）不抛错：记入返回值的 missing 清单，
 * 由导出编排层把对应节点降级为可见占位文本并计入 unsupported。
 */
import type { AssetAccessService } from "../assets/assetServices";
import type {
  MarkdownAssetResolver,
  UnsupportedMarkdownFeature,
} from "../../editor/markdown/types";

/** 文档中引用的一份资源（按文档顺序，attachmentId 已去重）。 */
export interface DocumentAssetRef {
  attachmentId: string;
  /** 节点上的建议文件名（图片 alt / 附件显示名），记录缺失时回退用。 */
  suggestedName: string;
  kind: "image" | "attachment";
}

interface JsonNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
}

/**
 * 收集文档 JSON 中全部 localImage/attachment 引用。
 * 按文档顺序遍历，同一 attachmentId 只保留首次出现（路径共用）。
 */
export function collectDocumentAssetRefs(
  document: unknown,
): DocumentAssetRef[] {
  const refs: DocumentAssetRef[] = [];
  const seen = new Set<string>();
  const walk = (node: JsonNode) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "localImage" || node.type === "attachment") {
      const attrs = node.attrs ?? {};
      const attachmentId =
        typeof attrs.attachmentId === "string" ? attrs.attachmentId : "";
      if (attachmentId && !seen.has(attachmentId)) {
        seen.add(attachmentId);
        const alt = typeof attrs.alt === "string" ? attrs.alt : "";
        const name = typeof attrs.name === "string" ? attrs.name : "";
        refs.push({
          attachmentId,
          suggestedName: node.type === "localImage" ? alt : name,
          kind: node.type === "localImage" ? "image" : "attachment",
        });
      }
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(document as JsonNode);
  return refs;
}

/**
 * 净化文件名：ZIP 条目名中的 `/`（目录分隔）与 `\`、控制字符替换为 `-`，
 * 去除首尾空白/点；净化后为空则回退 fallback。
 */
export function sanitizeFileName(name: string, fallback: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\\x00-\x1f]/g, "-")
    .trim()
    .replace(/^\.+/, "");
  return cleaned || fallback;
}

/**
 * 确定性分配唯一文件名：`name.ext` → `name (2).ext` → `name (3).ext`。
 * ext 以最后一个 `.` 划分（无扩展名时整体作为 base）。
 */
export function allocateUniqueName(
  desired: string,
  taken: ReadonlySet<string>,
): string {
  if (!taken.has(desired)) return desired;
  const dot = desired.lastIndexOf(".");
  const base = dot > 0 ? desired.slice(0, dot) : desired;
  const ext = dot > 0 ? desired.slice(dot) : "";
  for (let index = 2; ; index += 1) {
    const candidate = `${base} (${index})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** 一份已确定路径与字节的导出资源。 */
export interface PreparedAssetFile {
  /** ZIP / vault 内的相对路径（`assets/<文件名>`）。 */
  path: string;
  attachmentId: string;
  data: Uint8Array;
}

export interface PreparedExportAssets {
  /** 交给 codec serialize（portable 模式）的路径解析器。 */
  resolver: MarkdownAssetResolver;
  /** 需要随包写出的二进制文件（与 resolver 路径一一对应）。 */
  files: PreparedAssetFile[];
  /** 仓储中查不到记录的引用（导出编排层降级处理）。 */
  missing: DocumentAssetRef[];
}

/**
 * 经资源访问服务一次性确定全部资源路径与字节（resolver 闭包只读查询结果，
 * 不再访问服务）。记录读取失败按缺失处理，不中断导出。
 * R005 阶段 7A 起入参收窄为 getBinary 切片（函数本就只用这一个方法），
 * 完整 AssetAccessService 仍可直接传入，向后兼容。
 */
export async function prepareExportAssets(
  refs: DocumentAssetRef[],
  assetAccess: Pick<AssetAccessService, "getBinary">,
): Promise<PreparedExportAssets> {
  const taken = new Set<string>();
  const pathByAttachmentId = new Map<string, string>();
  const files: PreparedAssetFile[] = [];
  const missing: DocumentAssetRef[] = [];

  for (const ref of refs) {
    const binary = await assetAccess
      .getBinary(ref.attachmentId)
      .catch(() => undefined);
    if (!binary) {
      missing.push(ref);
      continue;
    }
    const fileName = allocateUniqueName(
      sanitizeFileName(binary.attachment.name || ref.suggestedName, "file"),
      taken,
    );
    taken.add(fileName);
    const path = `assets/${fileName}`;
    pathByAttachmentId.set(ref.attachmentId, path);
    files.push({
      path,
      attachmentId: ref.attachmentId,
      data: binary.data,
    });
  }

  const resolver: MarkdownAssetResolver = {
    resolveAssetPath({ attachmentId, name, kind }) {
      const existing = pathByAttachmentId.get(attachmentId);
      if (existing) return existing;
      // 防御性回退：prepare 之后文档被改写、出现未登记的引用时，
      // 仍按确定性规则生成路径（不抛错，序列化不中断）。
      const fileName = allocateUniqueName(
        sanitizeFileName(name, kind === "image" ? "image" : "attachment"),
        taken,
      );
      taken.add(fileName);
      return `assets/${fileName}`;
    },
  };

  return { resolver, files, missing };
}

/** 缺失附件引用转 unsupported 记录（导出报告用）。 */
export function missingAssetUnsupported(
  ref: DocumentAssetRef,
): UnsupportedMarkdownFeature {
  const label = ref.suggestedName || ref.attachmentId;
  return {
    kind: "missing-asset",
    snippet: label.length > 80 ? `${label.slice(0, 80)}…` : label,
    message: `附件记录缺失（可能已被清理），导出中已降级为可见占位文本（${
      ref.kind === "image" ? "图片" : "附件"
    }本体未导出）。`,
  };
}
