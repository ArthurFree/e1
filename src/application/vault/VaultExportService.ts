/**
 * Portable Vault 导出服务（R005 阶段 7，批次 7A）。
 *
 * 把知识库整体导出为 portable-vault.md 定稿的 `<知识库名>.e1.zip`：
 *
 * ```text
 * <知识库名>.e1.zip
 * ├── manifest.json        # format/formatVersion/generator/exportedAt/计数
 * ├── vault.json           # 知识库元数据（identityMode: frontmatter）
 * ├── notes/               # 页面树映射：group → 文件夹，document → <标题>.md
 * ├── assets/              # 附件二进制（localImage 与 attachment 共用）
 * └── metadata/
 *     ├── tree.json        # 页面树结构（id/parentId/kind/position/路径/收藏）
 *     └── page-map.json    # pageId → notes 路径映射（链接重写/稳定 ID 对照）
 * ```
 *
 * 关键规则（portable-vault.md §文件名冲突）：
 * - 全部 notes 路径与 assets 路径先整体确定（同目录同名按 `名.ext`、
 *   `名 (2).ext` 递增，净化规则与 4B sanitizeFileName 一致），再统一
 *   序列化 Markdown 生成相对链接——不边写边猜；
 * - Markdown 中的资源/提及链接为「从该 md 所在目录出发」的相对路径，
 *   由 relativePath 按目录深度计算（如 notes/工作/a.md → ../../assets/x.png）；
 * - 回收站页面（deletedAt 非空）与版本历史默认不导出；
 * - zip 条目按名称排序 + 4B zip writer 固定 DOS 时间戳，同一输入多次导出
 *   字节级一致；manifest.exportedAt 为真实导出时间，是唯一随时间变化的
 *   字段——测试经 deps.now 注入固定时钟即可断言字节确定性。
 *
 * 数据全部经 AppServices 公开面读取（queries + assets.access），不接触
 * 原始仓储；返回 zip 字节，下载触发留给 UI 层。导入侧（zip reader /
 * 导入编排）属批次 7B。
 */
import { DomainError } from "../../domain/errors";
import type { Page, PageTag } from "../../domain/types";
import { createMarkdownCodec } from "../../editor/markdown/codec";
import type { UnsupportedMarkdownFeature } from "../../editor/markdown/types";
import type { AssetAccessService } from "../assets/assetServices";
import {
  allocateUniqueName,
  collectDocumentAssetRefs,
  missingAssetUnsupported,
  prepareExportAssets,
  sanitizeFileName,
  type DocumentAssetRef,
} from "../markdown/assetResolver";
import { replaceMissingAssetNodes } from "../markdown/documentExport";
import type { DocumentQueryService } from "../queries/DocumentQueryService";
import type { WorkspaceQueryService } from "../queries/WorkspaceQueryService";
import { createZip, type ZipEntryInput } from "../services/zip";

const encoder = new TextEncoder();

/** 导出服务的只读依赖（AppServices 公开面的窄切片，测试可用仓储直组）。 */
export interface VaultExportDeps {
  workspaceQuery: Pick<
    WorkspaceQueryService,
    "listWorkspaces" | "loadPages" | "loadTags"
  >;
  documentQuery: Pick<DocumentQueryService, "getContent">;
  assetAccess: Pick<AssetAccessService, "getBinary">;
  /** 时钟注入（manifest.exportedAt）；缺省真实时间，测试传固定值断言字节确定性。 */
  now?: () => Date;
}

/** 导出摘要：供 UI 结果提示与测试断言。 */
export interface VaultExportSummary {
  /** 导出的文档数（manifest.noteCount 同值）。 */
  noteCount: number;
  /** 随包写出的附件文件数（manifest.assetCount 同值）。 */
  assetCount: number;
  /** 跳过未导出的回收站页面数（含分组）。 */
  skippedTrashCount: number;
  /** 记录缺失、已降级为占位文本的附件引用数。 */
  missingAssetCount: number;
  /** true 表示发生了有损转换（含附件缺失降级），明细见 unsupported。 */
  lossy: boolean;
  unsupported: UnsupportedMarkdownFeature[];
}

export interface VaultExportResult {
  /** 建议下载文件名（`<知识库名>.e1.zip`，已净化）。 */
  fileName: string;
  /** ZIP 字节流（调用方包成 Blob 触发下载）。 */
  data: Uint8Array;
  /** 包内条目名（诊断/测试用，按名称排序）。 */
  entryNames: string[];
  summary: VaultExportSummary;
}

/** 页面在 vault 内的布局记录（DFS 顺序，确定性）。 */
interface LayoutEntry {
  page: Page;
  /** group 为目录路径（notes/工作），document 为 md 路径（notes/工作/项目 A.md）。 */
  path: string;
}

/**
 * 计算 fromFile 所在目录到 toPath 的相对路径（两者均为 zip 根相对路径，
 * 以 `/` 分隔）。同目录时返回纯文件名。
 */
export function relativePath(fromFile: string, toPath: string): string {
  const fromDir = fromFile.split("/").slice(0, -1);
  const toSegments = toPath.split("/");
  let common = 0;
  while (
    common < fromDir.length &&
    common < toSegments.length &&
    fromDir[common] === toSegments[common]
  ) {
    common += 1;
  }
  const ups = fromDir.length - common;
  return [...Array<string>(ups).fill(".."), ...toSegments.slice(common)].join(
    "/",
  );
}

/**
 * 页面树 → notes/ 布局：group 映射为文件夹，document 映射为 <标题>.md。
 * 同级按 (position, id) 排序后依次经 allocateUniqueName 分配名字——
 * 同一输入多次导出路径完全一致（portable-vault.md 确定性要求）。
 */
function layoutNotesTree(pages: Page[]): LayoutEntry[] {
  const liveById = new Map(pages.map((page) => [page.id, page]));
  const childrenByParent = new Map<string | null, Page[]>();
  for (const page of pages) {
    // 防御：父级不在存活集合内（如父级在回收站而子级残留）时挂到根。
    const parentId =
      page.parentId !== null && liveById.has(page.parentId)
        ? page.parentId
        : null;
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(page);
    childrenByParent.set(parentId, siblings);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort(
      (a, b) => a.position - b.position || a.id.localeCompare(b.id),
    );
  }

  const layout: LayoutEntry[] = [];
  const walk = (parentId: string | null, dirPath: string) => {
    const taken = new Set<string>();
    for (const child of childrenByParent.get(parentId) ?? []) {
      if (child.kind === "group") {
        const name = allocateUniqueName(
          sanitizeFileName(child.title, "未命名分组"),
          taken,
        );
        taken.add(name);
        const path = `${dirPath}/${name}`;
        layout.push({ page: child, path });
        walk(child.id, path);
      } else {
        const name = allocateUniqueName(
          `${sanitizeFileName(child.title, "无标题")}.md`,
          taken,
        );
        taken.add(name);
        layout.push({ page: child, path: `${dirPath}/${name}` });
      }
    }
  };
  walk(null, "notes");
  return layout;
}

export class VaultExportService {
  constructor(private readonly deps: VaultExportDeps) {}

  /** 导出知识库为 Portable Vault zip 字节。知识库不存在时抛 DomainError。 */
  async exportWorkspace(workspaceId: string): Promise<VaultExportResult> {
    const now = this.deps.now ?? (() => new Date());
    const workspaces = await this.deps.workspaceQuery.listWorkspaces();
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace) {
      throw new DomainError("WORKSPACE_NOT_FOUND", "知识库不存在或已被删除。");
    }

    const [pages, { tags, pageTags }] = await Promise.all([
      this.deps.workspaceQuery.loadPages(workspaceId),
      this.deps.workspaceQuery.loadTags(workspaceId),
    ]);

    // 回收站与版本历史默认不导出（portable-vault.md 转换规则表）。
    const live = pages.filter((page) => page.deletedAt === null);
    const skippedTrashCount = pages.length - live.length;

    // —— 第一步：全部 notes 路径整体确定 ——
    const layout = layoutNotesTree(live);
    const documents = layout.filter((entry) => entry.page.kind === "document");
    const pageMap = new Map(
      documents.map((entry) => [entry.page.id, entry.path]),
    );

    // —— 第二步：读取正文，全部 assets 路径整体确定（全局同一命名空间） ——
    const contentByPage = new Map<string, unknown>();
    for (const entry of documents) {
      const content = await this.deps.documentQuery.getContent(entry.page.id);
      contentByPage.set(
        entry.page.id,
        content?.contentJson ?? { type: "doc", content: [] },
      );
    }
    const allRefs: DocumentAssetRef[] = [];
    const seenRef = new Set<string>();
    for (const entry of documents) {
      for (const ref of collectDocumentAssetRefs(
        contentByPage.get(entry.page.id),
      )) {
        if (seenRef.has(ref.attachmentId)) continue;
        seenRef.add(ref.attachmentId);
        allRefs.push(ref);
      }
    }
    const prepared = await prepareExportAssets(allRefs, this.deps.assetAccess);
    const missingIds = new Set(prepared.missing.map((ref) => ref.attachmentId));

    // —— 第三步：路径已定，统一序列化 Markdown（链接/引用按相对深度生成） ——
    const codec = createMarkdownCodec();
    const tagNameById = new Map(tags.map((tag) => [tag.id, tag.name]));
    const tagIdsByPage = collectTagIdsByPage(pageTags);
    const unsupported: UnsupportedMarkdownFeature[] = [];
    const entries: ZipEntryInput[] = [];

    for (const entry of documents) {
      const title = entry.page.title.trim() || "无标题";
      const raw = contentByPage.get(entry.page.id);
      const document =
        missingIds.size > 0 ? replaceMissingAssetNodes(raw, missingIds) : raw;
      const tagNames = (tagIdsByPage.get(entry.page.id) ?? [])
        .map((tagId) => tagNameById.get(tagId))
        .filter((name): name is string => name !== undefined);
      const result = await codec.serialize({
        document,
        metadata: {
          id: entry.page.id,
          title,
          tags: tagNames,
          createdAt: new Date(entry.page.createdAt).toISOString(),
          updatedAt: new Date(entry.page.updatedAt).toISOString(),
        },
        // assets/ 在 zip 根，md 在 notes/**：按目录深度补相对前缀。
        assetResolver: {
          resolveAssetPath: (input) =>
            relativePath(entry.path, prepared.resolver.resolveAssetPath(input)),
        },
        mode: "portable",
        // @ 提及：page-map 已全定，命中输出目标 md 相对路径；
        // 目标缺失（回收站/外部页面）返回 null，codec 按矩阵降级为纯文本。
        resolveMentionPath: (pageId) => {
          const target = pageMap.get(pageId);
          return target ? relativePath(entry.path, target) : null;
        },
      });
      entries.push({ name: entry.path, data: encoder.encode(result.markdown) });
      for (const item of result.unsupported) {
        unsupported.push({ ...item, message: `《${title}》${item.message}` });
      }
    }
    for (const ref of prepared.missing) {
      unsupported.push(missingAssetUnsupported(ref));
    }

    // —— 第四步：补齐目录/资源/元数据条目，按名称排序保证字节确定性 ——
    for (const entry of layout) {
      if (entry.page.kind === "group") {
        // 显式目录条目：空分组在 zip 中也能保留（unzip/ditto 均可识别）。
        entries.push({ name: `${entry.path}/`, data: new Uint8Array(0) });
      }
    }
    for (const file of prepared.files) {
      entries.push({ name: file.path, data: file.data });
    }
    const manifest = {
      format: "e1-vault",
      formatVersion: 1,
      generator: "e1-web",
      exportedAt: now().toISOString(),
      noteCount: documents.length,
      assetCount: prepared.files.length,
    };
    const vault = {
      format: "e1-vault",
      formatVersion: 1,
      vaultId: workspace.id,
      name: workspace.name,
      createdAt: new Date(workspace.createdAt).toISOString(),
      assetsDirectory: "assets",
      identityMode: "frontmatter",
    };
    const tree = {
      format: "e1-vault",
      formatVersion: 1,
      pages: layout.map((entry) => ({
        id: entry.page.id,
        parentId: entry.page.parentId,
        kind: entry.page.kind,
        title: entry.page.title,
        position: entry.page.position,
        favoriteAt: entry.page.favoriteAt,
        path: entry.path,
      })),
    };
    const pageMapJson = {
      format: "e1-vault",
      formatVersion: 1,
      pages: Object.fromEntries(pageMap),
    };
    const json = (value: unknown) =>
      encoder.encode(JSON.stringify(value, null, 2));
    entries.push(
      { name: "manifest.json", data: json(manifest) },
      { name: "vault.json", data: json(vault) },
      { name: "metadata/tree.json", data: json(tree) },
      { name: "metadata/page-map.json", data: json(pageMapJson) },
    );
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const data = createZip(entries);
    return {
      fileName: `${sanitizeFileName(workspace.name, "知识库")}.e1.zip`,
      data,
      entryNames: entries.map((entry) => entry.name),
      summary: {
        noteCount: documents.length,
        assetCount: prepared.files.length,
        skippedTrashCount,
        missingAssetCount: prepared.missing.length,
        lossy: unsupported.length > 0,
        unsupported,
      },
    };
  }
}

/** pageTags → pageId 到 tagId 列表（保持关联记录顺序）。 */
function collectTagIdsByPage(pageTags: PageTag[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const link of pageTags) {
    const list = map.get(link.pageId) ?? [];
    list.push(link.tagId);
    map.set(link.pageId, list);
  }
  return map;
}
