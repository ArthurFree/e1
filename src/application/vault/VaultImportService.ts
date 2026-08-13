/**
 * Portable Vault 导入服务（R005 阶段 7，批次 7B）。
 *
 * 把 7A 导出的 `<知识库名>.e1.zip` 重新导入为一个**新建知识库**——
 * 不覆盖任何既有知识库（portable-vault.md：导入即迁移/备份恢复通道）。
 * 流程对照 r005.md §十二：
 *
 * ```text
 * 读取 manifest → 校验 format/formatVersion → 解析全部 Markdown（codec.parse）
 * → 建立 noteId/path 映射（Frontmatter id 优先，缺失/重复记入报告）
 * → 创建页面树（metadata/tree.json 的层级与顺序优先；缺失时从 notes/ 目录推导）
 * → 原子创建正文（createWithContent，INV-04）
 * → 引用重写（资源 → 新 attachmentId；页面链接 → mention/纯文本）
 * → 建立标签关系（Frontmatter tags → 查/建标签 → setPageTags）
 * → 搜索索引同步（createWithContent/replaceContent 内部经 DocumentCommitService
 *    完成，无需额外通道——见 importVault 末尾注释）
 * → 输出导入报告
 * ```
 *
 * 与规格流程的一处顺序偏差（写入侧两阶段，注释在此说明）：规格先导入附件
 * 再创建正文，但 Web 模型的附件记录必须挂在已存在的 pageId 下，且页面 id
 * 由仓储在创建时生成——附件与 mention 重写都依赖「创建后才知道」的 id。
 * 因此每个文档走「createWithContent 写入解析原文 → 导入该文档引用的附件
 * → replaceContent 写入重写后正文」两段；两步各自原子（INV-04 / 单点提交），
 * 中间态只存在于本次调用内、不对外可见。无附件/无链接的文档只有一次
 * 原子写入。
 *
 * 失败原子性策略：manifest/格式版本/zip 损坏等整体性问题直接抛 DomainError
 * （不落任何数据）；单文档级失败（解析失败、写入失败、附件校验失败）记
 * 入报告 skipped/missingAssets 后继续——中途失败的文档跳过，不整库半拉。
 *
 * 引用重写取舍（对照 markdown-compatibility.md 矩阵导入方向）：
 * - 资源：`![alt](../assets/x.png)`（image 节点）→ localImage 节点（新
 *   attachmentId，alt 保留；宽度 Markdown 本就携带不了，导出侧已记损）；
 *   「整段只有一个附件链接」的段落 → attachment 节点（name 保留）；
 *   行内（句中）附件链接无法表达为块节点——链接标记剥离为纯文本并计
 *   入 unsupported（attachment-inline），附件本体不导入（无节点引用
 *   会被孤儿清理）；
 * - 页面间链接：codec parse 把相对 .md 链接保留为文本链接（links 矩阵
 *   既定语义）。导入侧对「整段文本仅有该链接」的节点还原为 mention
 *   节点（目标页 id 已映射）；混合格式或目标不在 vault 内的链接剥离
 *   href 保留文本并计入 unresolvedLinks——不写入死相对路径（点击会
 *   在 SPA 内导航到无效地址），也不强行猜测 mention 目标。
 */
import { DomainError } from "../../domain/errors";
import { createMarkdownCodec } from "../../editor/markdown/codec";
import { resolveRelativePath } from "../../editor/markdown/links";
import { jsonToText } from "../../editor/markdown";
import type {
  ParsedNote,
  UnsupportedMarkdownFeature,
} from "../../editor/markdown/types";
import type { AssetCommandService } from "../assets/AssetCommandService";
import type { DocumentCommandService } from "../commands/DocumentCommandService";
import type { PageCommandService } from "../commands/PageCommandService";
import type { TagCommandService } from "../commands/TagCommandService";
import type { WorkspaceCommandService } from "../commands/WorkspaceCommandService";
import type { WorkspaceQueryService } from "../queries/WorkspaceQueryService";
import { readZipEntries, toZipDomainError } from "../services/zipReader";

const decoder = new TextDecoder();

/** 支持的格式版本集（manifest.formatVersion）。 */
const SUPPORTED_FORMAT_VERSIONS = new Set([1]);
/** 导入创建的标签统一使用项目主色（TagPicker 轮换色板的第一色）。 */
const IMPORTED_TAG_COLOR = "#22A06B";

/** 导入服务的写依赖（AppServices 公开面的窄切片，测试可用仓储直组）。 */
export interface VaultImportDeps {
  workspaceQuery: Pick<WorkspaceQueryService, "listWorkspaces">;
  workspaceCommands: Pick<WorkspaceCommandService, "create">;
  pageCommands: Pick<PageCommandService, "create" | "toggleFavorite">;
  documentCommands: Pick<
    DocumentCommandService,
    "createWithContent" | "replaceContent"
  >;
  tagCommands: Pick<TagCommandService, "create" | "setPageTags">;
  assetCommands: Pick<AssetCommandService, "importAsset">;
}

export interface VaultImportOptions {
  /** 显式指定新知识库名；缺省取 vault.json 的 name。冲突时自动加后缀。 */
  targetWorkspaceName?: string;
}

/** 被跳过的文档（含原因）。 */
export interface VaultImportSkippedNote {
  /** notes/ 相对路径。 */
  path: string;
  reason: string;
}

/** 缺失或导入失败的附件引用。 */
export interface VaultImportMissingAsset {
  /** vault 内的资源路径（assets/...）。 */
  path: string;
  /** 引用它的笔记路径。 */
  referencedBy: string;
  /** 缺失原因（zip 内无此文件 / 校验失败等）。 */
  reason: string;
}

/** 无法解析（或无法还原）的页面链接。 */
export interface VaultImportUnresolvedLink {
  /** Markdown 中的原始链接目标。 */
  target: string;
  /** 引用它的笔记路径。 */
  referencedBy: string;
  reason: string;
}

/** 导入报告（字段对照 r005.md §十二 / portable-vault.md §导入报告字段）。 */
export interface VaultImportReport {
  /** 新知识库 id 与最终名称（冲突时已加后缀）。 */
  workspaceId: string;
  workspaceName: string;
  /** 知识库名发生冲突时的原名；无冲突为 null。 */
  workspaceRenamedFrom: string | null;
  /** 数据格式版本（manifest.formatVersion）。 */
  formatVersion: number;
  /** 成功导入的文档数。 */
  importedCount: number;
  /** 跳过的文档（解析/写入失败，含原因）。 */
  skipped: VaultImportSkippedNote[];
  /**
   * 文件名冲突对照（重命名前 → 后）。zip 条目名本身唯一，导入侧不改写
   * 文件名，本字段为格式要求预留；知识库名冲突见 workspaceRenamedFrom。
   */
  fileNameConflicts: { original: string; renamed: string }[];
  /** 无法识别语法汇总（含各文档 parse 的 unsupported 与导入侧降级）。 */
  unsupported: UnsupportedMarkdownFeature[];
  /** 缺失/导入失败的附件。 */
  missingAssets: VaultImportMissingAsset[];
  /** 无法解析/无法还原的页面链接。 */
  unresolvedLinks: VaultImportUnresolvedLink[];
  /** Frontmatter id 缺失的笔记路径（已生成新 id）。 */
  notesWithoutId: string[];
  /** Frontmatter id 重复的笔记（首次出现者保留映射，其余记录在此）。 */
  duplicateNoteIds: { id: string; path: string }[];
  /** 是否发生有损转换（unsupported/缺失附件/未解析链接任一非空）。 */
  lossy: boolean;
}

// —— 规划结构（创建前整体确定，与导出侧「先定路径再写」对称） ——

interface GroupPlan {
  /** notes/ 下的目录路径（如 notes/工作）。 */
  path: string;
  title: string;
  parentPath: string | null;
  favoriteAt: number | null;
}

interface NotePlan {
  /** notes/ 下的 md 路径（如 notes/工作/项目 A.md）。 */
  path: string;
  parsed: ParsedNote;
  title: string;
  parentPath: string | null;
  favoriteAt: number | null;
}

interface JsonMark {
  type: string;
  attrs?: Record<string, unknown>;
}

interface JsonNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: JsonMark[];
  content?: JsonNode[];
}

/** 外部/非相对目标：带协议、`//` 开头、绝对路径或纯锚点（与 links.ts 同规则）。 */
function isExternalTarget(target: string): boolean {
  return (
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) ||
    target.startsWith("//") ||
    target.startsWith("/") ||
    target.startsWith("#")
  );
}

/** 目标是否指向 Markdown 笔记（.md 后缀，忽略锚点/查询）。 */
function isMarkdownTarget(target: string): boolean {
  return /\.md$/i.test(target.split("#")[0].split("?")[0]);
}

/** 取路径最后一段（zip 内路径均为 `/` 分隔，已经过了安全校验）。 */
function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** 常见扩展名 → MIME（导入附件用；未知扩展回退 octet-stream）。 */
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  zip: "application/zip",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  mov: "video/quicktime",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function mimeFromName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** Frontmatter ISO 时间 → 毫秒时间戳；非法/缺失返回 undefined（仓储回退当前时间）。 */
function parseIsoToMillis(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? undefined : millis;
}

/** 报告收集器：跨阶段共享的可变累积结构，最后一次性组装为 VaultImportReport。 */
class ReportSink {
  readonly skipped: VaultImportSkippedNote[] = [];
  readonly unsupported: UnsupportedMarkdownFeature[] = [];
  readonly missingAssets: VaultImportMissingAsset[] = [];
  readonly unresolvedLinks: VaultImportUnresolvedLink[] = [];
  readonly notesWithoutId: string[] = [];
  readonly duplicateNoteIds: { id: string; path: string }[] = [];
}

/**
 * tree.json 的一个页面条目（7A 导出形状；宽松解析，字段缺失走回退）。
 */
interface TreePageEntry {
  id?: unknown;
  parentId?: unknown;
  kind?: unknown;
  title?: unknown;
  position?: unknown;
  favoriteAt?: unknown;
  path?: unknown;
}

export class VaultImportService {
  constructor(private readonly deps: VaultImportDeps) {}

  /**
   * 导入 Portable Vault zip 字节流为新建知识库。
   * 整体性格式问题抛 DomainError（不落数据）；文档级失败记入报告继续。
   */
  async importVault(
    data: Uint8Array,
    options?: VaultImportOptions,
  ): Promise<VaultImportReport> {
    // —— 1. 解压 zip ——
    const entries = await readZipEntries(data).catch((err: unknown) => {
      throw toZipDomainError(err);
    });
    const fileByName = new Map(
      entries.map((entry) => [entry.name, entry.data]),
    );

    // —— 2. manifest 校验（第一道关口） ——
    const manifestRaw = fileByName.get("manifest.json");
    if (!manifestRaw) {
      throw new DomainError(
        "INVALID_INPUT",
        "不是有效的 Portable Vault：缺少 manifest.json。",
      );
    }
    const manifest = parseJsonObject(manifestRaw, "manifest.json");
    if (manifest.format !== "e1-vault") {
      throw new DomainError(
        "INVALID_INPUT",
        "不是有效的 Portable Vault：manifest.format 不是 e1-vault。",
      );
    }
    const formatVersion =
      typeof manifest.formatVersion === "number" ? manifest.formatVersion : 0;
    if (!SUPPORTED_FORMAT_VERSIONS.has(formatVersion)) {
      throw new DomainError(
        "INVALID_INPUT",
        `数据格式版本不支持：${manifest.formatVersion ?? "未知"}（当前支持 v1）。`,
      );
    }

    // vault.json 缺省时降级（名称回退），不拒绝——宽容导入。
    const vaultRaw = fileByName.get("vault.json");
    const vault = vaultRaw ? parseJsonObject(vaultRaw, "vault.json") : null;
    const vaultName =
      typeof vault?.name === "string" && vault.name.trim()
        ? vault.name.trim()
        : "导入的知识库";

    // —— 3. 解析全部 Markdown（先解析后创建：整体解析失败不落任何数据） ——
    const codec = createMarkdownCodec();
    const sink = new ReportSink();
    const notePaths = entries
      .map((entry) => entry.name)
      .filter(
        (name) =>
          name.startsWith("notes/") &&
          name.toLowerCase().endsWith(".md") &&
          // 防御：notes 一级之外的前导段已在 zip slip 校验排除，这里只防空段。
          !name.split("/").includes(""),
      )
      .sort();
    const parsedByPath = new Map<string, ParsedNote>();
    for (const path of notePaths) {
      try {
        const parsed = await codec.parse({
          markdown: decoder.decode(fileByName.get(path)),
          relativePath: path,
        });
        parsedByPath.set(path, parsed);
      } catch (err) {
        sink.skipped.push({
          path,
          reason: `Markdown 解析失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // —— 4. 建立页面树规划（tree.json 优先；缺失时从 notes/ 目录推导） ——
    const { groups, notes } = buildLayout(
      fileByName.get("metadata/tree.json"),
      parsedByPath,
      sink,
    );

    // —— 5. 创建目标知识库（名称冲突确定性加后缀，不覆盖既有知识库） ——
    const baseNameInput = options?.targetWorkspaceName?.trim() || vaultName;
    const existing = await this.deps.workspaceQuery.listWorkspaces();
    const takenNames = new Set(existing.map((ws) => ws.name));
    let finalName = baseNameInput;
    if (takenNames.has(finalName)) {
      finalName = `${baseNameInput}（导入）`;
      for (let index = 2; takenNames.has(finalName); index += 1) {
        finalName = `${baseNameInput}（导入 ${index}）`;
      }
    }
    const workspace = await this.deps.workspaceCommands.create(finalName);

    // —— 6. 创建分组（父先子后，创建顺序即同级 position 顺序） ——
    const groupIdByPath = new Map<string, string>();
    for (const group of groups) {
      const parentId =
        group.parentPath !== null
          ? (groupIdByPath.get(group.parentPath) ?? null)
          : null;
      try {
        const page = await this.deps.pageCommands.create({
          workspaceId: workspace.id,
          parentId,
          kind: "group",
          title: group.title,
        });
        groupIdByPath.set(group.path, page.id);
        if (group.favoriteAt !== null) {
          await this.deps.pageCommands.toggleFavorite(
            page.id,
            group.favoriteAt,
          );
        }
      } catch (err) {
        // 分组失败不中断：其子树页面挂到根（parentId 映射查不到即回退 null）。
        sink.skipped.push({
          path: group.path,
          reason: `分组创建失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // —— 7. 逐文档创建 + 引用重写 + 标签 ——
    // Frontmatter id → 笔记路径（链接/诊断用；重复 id 首次出现者保留）。
    const pathByNoteId = new Map<string, string>();
    for (const note of notes) {
      const id = note.parsed.metadata.id;
      if (!id) {
        sink.notesWithoutId.push(note.path);
      } else if (pathByNoteId.has(id)) {
        sink.duplicateNoteIds.push({ id, path: note.path });
      } else {
        pathByNoteId.set(id, note.path);
      }
    }

    const pageIdByPath = new Map<string, string>();
    const tagIdByName = new Map<string, string>();
    let importedCount = 0;

    for (const note of notes) {
      const parentId =
        note.parentPath !== null
          ? (groupIdByPath.get(note.parentPath) ?? null)
          : null;
      // 7a. 原子创建「页面 + 解析原文」（原始相对引用随后两阶段重写）。
      let pageId: string;
      try {
        const page = await this.deps.documentCommands.createWithContent({
          workspaceId: workspace.id,
          parentId,
          title: note.title,
          contentJson: note.parsed.document,
          textSnapshot: jsonToText(note.parsed.document),
          createdAt: parseIsoToMillis(note.parsed.metadata.createdAt),
          updatedAt: parseIsoToMillis(note.parsed.metadata.updatedAt),
        });
        pageId = page.id;
      } catch (err) {
        sink.skipped.push({
          path: note.path,
          reason: `文档创建失败：${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
      pageIdByPath.set(note.path, pageId);
      importedCount += 1;
      if (note.favoriteAt !== null) {
        await this.deps.pageCommands
          .toggleFavorite(pageId, note.favoriteAt)
          .catch(() => {});
      }

      // 7b. parse 侧 unsupported 汇总进报告（带文档名前缀，与导出侧一致）。
      for (const item of note.parsed.unsupported) {
        sink.unsupported.push({
          ...item,
          message: `《${note.title}》${item.message}`,
        });
      }

      // 7c. 标签：Frontmatter tags 名称 → 查/建标签 → 关联。
      const tagIds: string[] = [];
      for (const name of note.parsed.metadata.tags) {
        const trimmed = name.trim();
        if (!trimmed) continue;
        let tagId = tagIdByName.get(trimmed);
        if (!tagId) {
          try {
            const tag = await this.deps.tagCommands.create(
              workspace.id,
              trimmed,
              IMPORTED_TAG_COLOR,
            );
            tagId = tag.id;
            tagIdByName.set(trimmed, tagId);
          } catch (err) {
            sink.unsupported.push({
              kind: "tag",
              snippet: trimmed,
              message: `《${note.title}》标签「${trimmed}」创建失败：${
                err instanceof Error ? err.message : String(err)
              }（页面已导入，未建立该标签关联）。`,
            });
            continue;
          }
        }
        tagIds.push(tagId);
      }
      if (tagIds.length > 0) {
        await this.deps.tagCommands.setPageTags(pageId, tagIds).catch(() => {
          sink.unsupported.push({
            kind: "tag",
            snippet: note.title,
            message: `《${note.title}》标签关联写入失败（页面已导入）。`,
          });
        });
      }
    }

    // —— 8. 引用重写（全部 pageId 已定，再统一重写，与导出侧对称） ——
    for (const note of notes) {
      const pageId = pageIdByPath.get(note.path);
      if (!pageId) continue;
      const rewritten = await this.rewriteNoteContent(
        note,
        pageId,
        fileByName,
        pageIdByPath,
        sink,
      );
      if (!rewritten) continue;
      await this.deps.documentCommands
        .replaceContent({
          pageId,
          contentJson: rewritten,
          textSnapshot: jsonToText(rewritten),
        })
        .catch((err: unknown) => {
          sink.unsupported.push({
            kind: "rewrite",
            snippet: note.title,
            message: `《${note.title}》引用重写后的正文提交失败：${
              err instanceof Error ? err.message : String(err)
            }（保留未重写的解析原文）。`,
          });
        });
    }

    // 搜索索引：createWithContent / replaceContent 均经 DocumentCommitService
    // 单点提交，内部已同步 SearchIndexPort（INV-05）——导入无需额外索引通道。

    return {
      workspaceId: workspace.id,
      workspaceName: finalName,
      workspaceRenamedFrom: finalName === baseNameInput ? null : baseNameInput,
      formatVersion,
      importedCount,
      skipped: sink.skipped,
      fileNameConflicts: [],
      unsupported: sink.unsupported,
      missingAssets: sink.missingAssets,
      unresolvedLinks: sink.unresolvedLinks,
      notesWithoutId: sink.notesWithoutId,
      duplicateNoteIds: sink.duplicateNoteIds,
      lossy:
        sink.unsupported.length > 0 ||
        sink.missingAssets.length > 0 ||
        sink.unresolvedLinks.length > 0,
    };
  }

  /**
   * 重写单篇笔记的资源与页面链接引用。无需重写时返回 null（省去一次
   * replaceContent）；需要重写时返回新文档 JSON。
   */
  private async rewriteNoteContent(
    note: NotePlan,
    pageId: string,
    fileByName: ReadonlyMap<string, Uint8Array>,
    pageIdByPath: ReadonlyMap<string, string>,
    sink: ReportSink,
  ): Promise<unknown | null> {
    // —— 分类该文档的资源引用（块级可还原 / 行内降级） ——
    // blockAssetRefs：image 节点 src 与「整段单链接」附件，导入后成为
    // localImage/attachment 节点；resolvedPath → 引用形态。
    const blockAssetKinds = new Map<string, "image" | "attachment">();
    const collect = (node: JsonNode | undefined) => {
      if (!node || typeof node !== "object") return;
      if (node.type === "image" && typeof node.attrs?.src === "string") {
        const src = node.attrs.src;
        if (!isExternalTarget(src) && !src.startsWith("data:")) {
          const resolved = resolveRelativePath(note.path, src);
          if (resolved) blockAssetKinds.set(resolved, "image");
        }
      }
      const soleLink = soleLinkText(node);
      if (soleLink && !isExternalTarget(soleLink.href)) {
        if (!isMarkdownTarget(soleLink.href)) {
          const resolved = resolveRelativePath(note.path, soleLink.href);
          if (resolved) blockAssetKinds.set(resolved, "attachment");
        }
      }
      for (const child of node.content ?? []) collect(child);
    };
    collect(note.parsed.document as JsonNode);

    // —— 导入块级资源（原路径 → 新 attachmentId） ——
    const attachmentIdByPath = new Map<string, string>();
    for (const [resolvedPath, kind] of blockAssetKinds) {
      const bytes = fileByName.get(resolvedPath);
      if (!bytes) {
        sink.missingAssets.push({
          path: resolvedPath,
          referencedBy: note.path,
          reason: "ZIP 包内缺少该资源文件",
        });
        continue;
      }
      const name = baseName(resolvedPath);
      try {
        const record = await this.deps.assetCommands.importAsset({
          pageId,
          name,
          mimeType: mimeFromName(name),
          size: bytes.byteLength,
          source: { kind: "bytes", data: bytes },
          requireImage: kind === "image",
        });
        attachmentIdByPath.set(resolvedPath, record.id);
      } catch (err) {
        sink.missingAssets.push({
          path: resolvedPath,
          referencedBy: note.path,
          reason: `附件导入失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // —— 文档 JSON 重写遍历 ——
    let changed = false;
    const rewrite = (node: JsonNode): JsonNode => {
      if (!node || typeof node !== "object") return node;

      // image 节点 → localImage（命中已导入资源）/ 占位段落（资源缺失）。
      if (node.type === "image" && typeof node.attrs?.src === "string") {
        const src = node.attrs.src;
        if (!isExternalTarget(src) && !src.startsWith("data:")) {
          const resolved = resolveRelativePath(note.path, src);
          const alt =
            typeof node.attrs.alt === "string" && node.attrs.alt
              ? node.attrs.alt
              : baseName(resolved ?? src);
          const attachmentId = resolved
            ? attachmentIdByPath.get(resolved)
            : undefined;
          if (attachmentId) {
            changed = true;
            return {
              type: "localImage",
              attrs: { attachmentId, alt, width: null },
            };
          }
          if (resolved && blockAssetKinds.has(resolved)) {
            // 资源缺失/导入失败：降级为可见占位文本（格式同导出侧）。
            changed = true;
            return {
              type: "paragraph",
              content: [{ type: "text", text: `（图片：${alt}）` }],
            };
          }
        }
        return node;
      }

      // 「整段单链接」段落 → attachment 节点（资源）或保持（页面链接在下文处理）。
      const soleLink = soleLinkText(node);
      if (soleLink && !isExternalTarget(soleLink.href)) {
        const resolved = resolveRelativePath(note.path, soleLink.href);
        if (!isMarkdownTarget(soleLink.href) && resolved) {
          const attachmentId = attachmentIdByPath.get(resolved);
          if (attachmentId) {
            changed = true;
            return {
              type: "attachment",
              attrs: {
                attachmentId,
                name: soleLink.text || baseName(resolved),
              },
            };
          }
          if (blockAssetKinds.has(resolved)) {
            changed = true;
            return {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: `（附件：${soleLink.text || baseName(resolved)}）`,
                },
              ],
            };
          }
        }
      }

      // 文本节点的链接标记：页面链接还原 mention / 剥离死链接。
      if (node.type === "text" && Array.isArray(node.marks)) {
        const linkMark = node.marks.find(
          (mark) =>
            mark.type === "link" && typeof mark.attrs?.href === "string",
        );
        const href =
          linkMark && typeof linkMark.attrs?.href === "string"
            ? linkMark.attrs.href
            : null;
        if (linkMark && href !== null && !isExternalTarget(href)) {
          const resolved = resolveRelativePath(note.path, href);
          if (isMarkdownTarget(href)) {
            const targetPageId = resolved
              ? pageIdByPath.get(resolved)
              : undefined;
            if (targetPageId && node.marks.length === 1) {
              // 整段文本仅该链接：还原为 mention 节点。
              changed = true;
              return {
                type: "mention",
                attrs: { id: targetPageId, label: node.text ?? "" },
              };
            }
            changed = true;
            sink.unresolvedLinks.push({
              target: href,
              referencedBy: note.path,
              reason: targetPageId
                ? "链接与其他格式混合，无法还原为页面提及（保留文本）"
                : "链接目标不在本 Vault 内（保留文本）",
            });
            return stripLinkMark(node, linkMark);
          }
          // 行内附件链接：块级形态上文已处理，这里只剩行内降级。
          changed = true;
          if (resolved && fileByName.has(resolved)) {
            sink.unsupported.push({
              kind: "attachment-inline",
              snippet: node.text,
              message: `《${note.title}》行内附件链接「${
                node.text ?? href
              }」无法还原为附件块，已保留为纯文本（附件本体未导入）。`,
            });
          } else if (resolved) {
            sink.missingAssets.push({
              path: resolved,
              referencedBy: note.path,
              reason: "ZIP 包内缺少该资源文件（行内引用）",
            });
          }
          return stripLinkMark(node, linkMark);
        }
      }

      if (!Array.isArray(node.content)) return node;
      let childChanged = false;
      const content = node.content.map((child) => {
        const next = rewrite(child);
        if (next !== child) childChanged = true;
        return next;
      });
      if (!childChanged) return node;
      return { ...node, content };
    };

    const result = rewrite(note.parsed.document as JsonNode);
    return changed ? result : null;
  }
}

/** 段落的唯一子节点是「仅带一个链接标记」的文本节点时，返回该链接信息。 */
function soleLinkText(node: JsonNode): { href: string; text: string } | null {
  if (node.type !== "paragraph" || node.content?.length !== 1) return null;
  const child = node.content[0];
  if (child.type !== "text" || !Array.isArray(child.marks)) return null;
  const linkMarks = child.marks.filter((mark) => mark.type === "link");
  if (linkMarks.length !== 1 || child.marks.length !== 1) return null;
  const href = linkMarks[0].attrs?.href;
  if (typeof href !== "string") return null;
  return { href, text: child.text ?? "" };
}

/** 移除文本节点上的指定链接标记（保留其余标记与文本）。 */
function stripLinkMark(node: JsonNode, linkMark: JsonMark): JsonNode {
  const marks = (node.marks ?? []).filter((mark) => mark !== linkMark);
  const out: JsonNode = { ...node };
  if (marks.length > 0) out.marks = marks;
  else delete out.marks;
  return out;
}

/** 解析 JSON 条目为对象；非对象/解析失败抛 DomainError。 */
function parseJsonObject(
  data: Uint8Array,
  name: string,
): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(decoder.decode(data));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("顶层不是对象");
    }
    return value as Record<string, unknown>;
  } catch (err) {
    throw new DomainError(
      "INVALID_INPUT",
      `Portable Vault 元数据损坏（${name}）：${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * 建立页面树规划：metadata/tree.json 的层级/顺序优先；缺失或条目不全时
 * 从 notes/ 目录结构推导补充。返回创建顺序（父先子后）。
 */
function buildLayout(
  treeRaw: Uint8Array | undefined,
  parsedByPath: ReadonlyMap<string, ParsedNote>,
  sink: ReportSink,
): { groups: GroupPlan[]; notes: NotePlan[] } {
  const groups: GroupPlan[] = [];
  const notes: NotePlan[] = [];
  const plannedPaths = new Set<string>();

  if (treeRaw) {
    let pages: TreePageEntry[] = [];
    try {
      const tree = parseJsonObject(treeRaw, "metadata/tree.json");
      if (Array.isArray(tree.pages)) pages = tree.pages as TreePageEntry[];
    } catch {
      // tree.json 损坏不致命：回退目录推导（portable-vault.md：缺失时扫描重建）。
      sink.unsupported.push({
        kind: "tree-json",
        message:
          "metadata/tree.json 损坏，页面树已从 notes/ 目录结构推导（排序可能变化）。",
      });
    }
    // tree.json 为 DFS 序（导出侧按 position 排好），父条目先于子条目。
    const pathById = new Map<string, string>();
    for (const entry of pages) {
      const path = typeof entry.path === "string" ? entry.path : "";
      const id = typeof entry.id === "string" ? entry.id : "";
      if (!path) continue;
      if (id) pathById.set(id, path);
      const parentId =
        typeof entry.parentId === "string" ? entry.parentId : null;
      const parentPath = parentId ? (pathById.get(parentId) ?? null) : null;
      const favoriteAt =
        typeof entry.favoriteAt === "number" && entry.favoriteAt > 0
          ? entry.favoriteAt
          : null;
      const title =
        typeof entry.title === "string" && entry.title.trim()
          ? entry.title
          : "";
      if (entry.kind === "group") {
        groups.push({
          path,
          title: title || baseName(path),
          parentPath,
          favoriteAt,
        });
      } else if (parsedByPath.has(path)) {
        plannedPaths.add(path);
        notes.push({
          path,
          parsed: parsedByPath.get(path)!,
          title: noteTitle(parsedByPath.get(path)!, path, title),
          parentPath,
          favoriteAt,
        });
      } else if (entry.kind === "document") {
        // tree.json 引用了 zip 内不存在的 md 文件：记跳过，不中断。
        sink.skipped.push({
          path,
          reason: "metadata/tree.json 引用了包内缺失的 Markdown 文件",
        });
      }
    }
  }

  // 目录推导：tree.json 缺失或遗漏的笔记，按路径排序补充（确定性）。
  const remaining = [...parsedByPath.keys()]
    .filter((path) => !plannedPaths.has(path))
    .sort();
  for (const path of remaining) {
    const parentPath = ensureDerivedGroups(path, groups);
    notes.push({
      path,
      parsed: parsedByPath.get(path)!,
      title: noteTitle(parsedByPath.get(path)!, path, ""),
      parentPath,
      favoriteAt: null,
    });
  }
  return { groups, notes };
}

/**
 * 为笔记路径推导缺失的分组目录（notes/a/b/c.md → notes/a、notes/a/b），
 * 返回该笔记的父目录路径（根为 null）。幂等：已存在的目录不重复添加。
 */
function ensureDerivedGroups(
  notePath: string,
  groups: GroupPlan[],
): string | null {
  const segments = notePath.split("/").slice(0, -1); // 去掉文件名
  // segments[0] 固定为 "notes"，目录从第二段开始。
  let parentPath: string | null = null;
  for (let i = 1; i < segments.length; i += 1) {
    const path = segments.slice(0, i + 1).join("/");
    if (!groups.some((group) => group.path === path)) {
      groups.push({
        path,
        title: segments[i],
        parentPath,
        favoriteAt: null,
      });
    }
    parentPath = path;
  }
  return parentPath;
}

/** 文档标题：Frontmatter title 优先，其次 tree.json，最后文件名。 */
function noteTitle(
  parsed: ParsedNote,
  path: string,
  treeTitle: string,
): string {
  const frontmatterTitle = parsed.metadata.title?.trim();
  if (frontmatterTitle) return frontmatterTitle;
  if (treeTitle.trim()) return treeTitle.trim();
  return baseName(path).replace(/\.md$/i, "") || "无标题";
}
