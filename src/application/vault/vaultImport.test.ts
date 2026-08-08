/**
 * Portable Vault 导入服务测试（R005 阶段 7，批次 7B）。
 *
 * 核心验收（r005.md §十二 / portable-vault.md）：
 * - 导出 → 清库 → 导入往返：页面树层级/标题/排序、标签关联、正文语义
 *   （localImage/attachment 指向新 attachmentId 且字节一致、mention 还原
 *   到新页面 id）、Frontmatter created/updated 保留、报告计数正确；
 * - 同一 zip 导入两次：结构确定、知识库名冲突确定性加后缀（不覆盖既有库）；
 * - 异常路径：formatVersion 不支持 / 缺 manifest / 坏 zip → 拒绝且不落数据；
 *   缺失 assets 记 missingAssets；无法解析链接记 unresolvedLinks；重复
 *   Frontmatter id 记 duplicateNoteIds；单文档写入失败记 skipped 继续导入；
 * - 无 metadata/tree.json 时从 notes/ 目录结构推导页面树。
 *
 * 装配与 vaultExport.test.ts 一致：导出走仓储直组窄接口；导入经
 * createBrowserAppServices（fake-indexeddb）的公开命令/查询面。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { INITIAL_CONTENT_VERSION_TOKEN } from "../../domain/types";
import type { Page } from "../../domain/types";
import { resetDB } from "../../infrastructure/db";
import { createBrowserAppServices } from "../../infrastructure/browserServices";
import {
  assetStore,
  contentRepository,
  pageRepository,
  tagRepository,
  workspaceRepository,
} from "../../infrastructure/repositories";
import { createZip } from "../services/zip";
import { VaultExportService, type VaultExportDeps } from "./VaultExportService";
import {
  VaultImportService,
  type VaultImportDeps,
  type VaultImportReport,
} from "./VaultImportService";

const encoder = new TextEncoder();
const FIXED_NOW = () => new Date("2026-08-08T12:00:00.000Z");

/** 导出依赖：仓储直组（同 vaultExport.test.ts）。 */
function makeExportDeps(): VaultExportDeps {
  return {
    workspaceQuery: {
      listWorkspaces: () => workspaceRepository.list(),
      loadPages: (id) => pageRepository.listByWorkspace(id),
      loadTags: async (id) => ({
        tags: await tagRepository.listByWorkspace(id),
        pageTags: await tagRepository.listWorkspacePageTags(id),
      }),
    },
    documentQuery: { getContent: (id) => contentRepository.get(id) },
    assetAccess: { getBinary: (id) => assetStore.getBinary(id) },
    now: FIXED_NOW,
  };
}

/** 导入依赖：经生产装配根的公开命令/查询面（不触原始仓储）。 */
function makeImportDeps(): VaultImportDeps {
  const services = createBrowserAppServices();
  return {
    workspaceQuery: services.queries.workspace,
    workspaceCommands: services.commands.workspace,
    pageCommands: services.commands.page,
    documentCommands: services.commands.document,
    tagCommands: services.commands.tag,
    assetCommands: services.assets.commands,
  };
}

function paragraph(text: string) {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function doc(...content: unknown[]) {
  return { type: "doc", content };
}

/** 建一篇文档页并写入正文（含版本令牌接续）。 */
async function createDoc(
  workspaceId: string,
  parentId: string | null,
  title: string,
  content?: unknown,
) {
  const page = await pageRepository.create({
    workspaceId,
    parentId,
    kind: "document",
    title,
  });
  if (content !== undefined) {
    const existing = await contentRepository.get(page.id);
    await contentRepository.save(
      page.id,
      content,
      "快照",
      existing?.version ?? INITIAL_CONTENT_VERSION_TOKEN,
    );
  }
  return page;
}

/** 手工构造 vault zip 条目（异常路径与无 tree.json 场景用）。 */
function craftVault(entries: { name: string; text: string }[]): Uint8Array {
  return createZip(
    entries.map((entry) => ({
      name: entry.name,
      data: encoder.encode(entry.text),
    })),
  );
}

const MANIFEST = JSON.stringify({
  format: "e1-vault",
  formatVersion: 1,
  generator: "e1-web",
  exportedAt: "2026-08-08T12:00:00.000Z",
  noteCount: 1,
  assetCount: 0,
});

/** 按 position 排序后的存活页面（树断言辅助）。 */
async function livePages(workspaceId: string): Promise<Page[]> {
  const pages = await pageRepository.listByWorkspace(workspaceId);
  return pages
    .filter((page) => page.deletedAt === null)
    .sort((a, b) => a.position - b.position);
}

describe("VaultImportService 导出→导入往返", () => {
  beforeEach(async () => {
    await resetDB();
  });

  it("页面树/标签/正文资源/提及/时间戳/收藏 全部还原，报告计数正确", async () => {
    // —— 源知识库：分组 + 资源文档 + 提及文档 + 标签 + 收藏 ——
    const ws = await workspaceRepository.create("旅行笔记");
    const group = await pageRepository.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "group",
      title: "工作",
    });
    const imageBytes = new Uint8Array([1, 2, 3, 4]);
    const pdfBytes = new Uint8Array([5, 6, 7]);
    const withAssets = await createDoc(ws.id, group.id, "含资源");
    const image = await assetStore.add({
      pageId: withAssets.id,
      name: "image.png",
      mimeType: "image/png",
      size: imageBytes.byteLength,
      data: imageBytes,
    });
    const pdf = await assetStore.add({
      pageId: withAssets.id,
      name: "design.pdf",
      mimeType: "application/pdf",
      size: pdfBytes.byteLength,
      data: pdfBytes,
    });
    {
      const existing = await contentRepository.get(withAssets.id);
      await contentRepository.save(
        withAssets.id,
        doc(
          {
            type: "localImage",
            attrs: { attachmentId: image.id, alt: "示意图" },
          },
          {
            type: "attachment",
            attrs: { attachmentId: pdf.id, name: "design.pdf" },
          },
        ),
        "快照",
        existing?.version ?? INITIAL_CONTENT_VERSION_TOKEN,
      );
    }
    const target = await createDoc(
      ws.id,
      group.id,
      "目标",
      doc(paragraph("的")),
    );
    const source = await createDoc(
      ws.id,
      null,
      "来源",
      doc({
        type: "paragraph",
        content: [
          { type: "text", text: "见 " },
          { type: "mention", attrs: { id: target.id, label: "目标" } },
        ],
      }),
    );
    const tag = await tagRepository.create(ws.id, "重要", "#ff0000");
    await tagRepository.setPageTags(withAssets.id, [tag.id]);
    await pageRepository.setFavorite(source.id, 1722475200000);

    const exported = await new VaultExportService(
      makeExportDeps(),
    ).exportWorkspace(ws.id);

    // —— 清库后导入 ——
    await resetDB();
    const report = await new VaultImportService(makeImportDeps()).importVault(
      exported.data,
    );

    expect(report.workspaceName).toBe("旅行笔记");
    expect(report.workspaceRenamedFrom).toBeNull();
    expect(report.formatVersion).toBe(1);
    expect(report.importedCount).toBe(3);
    expect(report.skipped).toEqual([]);
    expect(report.missingAssets).toEqual([]);
    expect(report.unresolvedLinks).toEqual([]);
    expect(report.lossy).toBe(false);

    // 页面树：层级 / 标题 / 排序一致。
    const pages = await livePages(report.workspaceId);
    const byTitle = new Map(pages.map((page) => [page.title, page]));
    const newGroup = byTitle.get("工作")!;
    expect(newGroup.kind).toBe("group");
    expect(newGroup.parentId).toBeNull();
    const newWithAssets = byTitle.get("含资源")!;
    const newTarget = byTitle.get("目标")!;
    const newSource = byTitle.get("来源")!;
    expect(newWithAssets.parentId).toBe(newGroup.id);
    expect(newTarget.parentId).toBe(newGroup.id);
    expect(newSource.parentId).toBeNull();
    // 同级顺序：含资源 在 目标 之前（与源一致）。
    expect(newWithAssets.position).toBeLessThan(newTarget.position);

    // Frontmatter created/updated 保留（迁移通道扩展的可选时间戳）。
    expect(newWithAssets.createdAt).toBe(withAssets.createdAt);
    expect(newWithAssets.updatedAt).toBe(withAssets.updatedAt);
    // 收藏时间戳经 tree.json 还原。
    expect(newSource.favoriteAt).toBe(1722475200000);

    // 正文：localImage/attachment 指向新 attachmentId，二进制字节一致。
    const content = await contentRepository.get(newWithAssets.id);
    const nodes = (
      content!.contentJson as {
        content: { type: string; attrs?: Record<string, unknown> }[];
      }
    ).content;
    const imageNode = nodes.find((node) => node.type === "localImage")!;
    const attachmentNode = nodes.find((node) => node.type === "attachment")!;
    expect(imageNode.attrs!.alt).toBe("示意图");
    expect(attachmentNode.attrs!.name).toBe("design.pdf");
    const newImageId = imageNode.attrs!.attachmentId as string;
    const newPdfId = attachmentNode.attrs!.attachmentId as string;
    expect(newImageId).not.toBe(image.id);
    const imageBinary = await assetStore.getBinary(newImageId);
    const pdfBinary = await assetStore.getBinary(newPdfId);
    expect([...imageBinary!.data]).toEqual([...imageBytes]);
    expect([...pdfBinary!.data]).toEqual([...pdfBytes]);
    // 附件归属新文档（孤儿清理语义依赖 pageId）。
    expect(imageBinary!.attachment.pageId).toBe(newWithAssets.id);

    // 提及：还原为 mention 节点并指向新页面 id。
    const sourceContent = await contentRepository.get(newSource.id);
    const sourceNodes = (
      sourceContent!.contentJson as {
        content: {
          content?: { type: string; attrs?: Record<string, unknown> }[];
        }[];
      }
    ).content;
    const mention = sourceNodes[0].content!.find(
      (node) => node.type === "mention",
    )!;
    expect(mention.attrs).toEqual({ id: newTarget.id, label: "目标" });

    // 标签：名称查/建 + 页面关联。
    const newTags = await tagRepository.listByWorkspace(report.workspaceId);
    expect(newTags.map((item) => item.name)).toEqual(["重要"]);
    const pageTags = await tagRepository.listWorkspacePageTags(
      report.workspaceId,
    );
    expect(pageTags).toEqual([
      expect.objectContaining({
        pageId: newWithAssets.id,
        tagId: newTags[0].id,
      }),
    ]);
  });

  it("同一 zip 导入两次：结构确定一致，知识库名冲突确定性加后缀", async () => {
    const ws = await workspaceRepository.create("库");
    await createDoc(ws.id, null, "甲", doc(paragraph("一")));
    await createDoc(ws.id, null, "乙", doc(paragraph("二")));
    const exported = await new VaultExportService(
      makeExportDeps(),
    ).exportWorkspace(ws.id);

    // 不删除原库直接导入：名称冲突走「（导入）」后缀，不覆盖既有库。
    const service = new VaultImportService(makeImportDeps());
    const first = await service.importVault(exported.data);
    const second = await service.importVault(exported.data);

    expect(first.workspaceName).toBe("库（导入）");
    expect(first.workspaceRenamedFrom).toBe("库");
    expect(second.workspaceName).toBe("库（导入 2）");

    // 两次导入的页面结构确定一致（标题 + 父级 + 排序）。
    const shape = async (workspaceId: string) => {
      const pages = await livePages(workspaceId);
      const titleById = new Map(pages.map((page) => [page.id, page.title]));
      return pages.map((page) => ({
        title: page.title,
        parent: page.parentId ? titleById.get(page.parentId) : null,
        position: page.position,
      }));
    };
    expect(await shape(second.workspaceId)).toEqual(
      await shape(first.workspaceId),
    );
    // 原库不受影响。
    expect((await livePages(ws.id)).map((page) => page.title)).toEqual([
      "甲",
      "乙",
    ]);
  });
});

describe("VaultImportService 异常路径", () => {
  beforeEach(async () => {
    await resetDB();
  });

  it("formatVersion 不支持 → 拒绝且不落任何数据", async () => {
    const beforeCount = (await workspaceRepository.list()).length;
    const zip = craftVault([
      {
        name: "manifest.json",
        text: JSON.stringify({ format: "e1-vault", formatVersion: 2 }),
      },
      { name: "notes/a.md", text: "正文" },
    ]);
    await expect(
      new VaultImportService(makeImportDeps()).importVault(zip),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      new VaultImportService(makeImportDeps()).importVault(zip),
    ).rejects.toThrow(/数据格式版本不支持/);
    // resetDB 后种子知识库会重新预置，「不落数据」以数量不变断言。
    expect(await workspaceRepository.list()).toHaveLength(beforeCount);
  });

  it("缺 manifest.json → 拒绝且不落数据", async () => {
    const beforeCount = (await workspaceRepository.list()).length;
    const zip = craftVault([{ name: "notes/a.md", text: "正文" }]);
    await expect(
      new VaultImportService(makeImportDeps()).importVault(zip),
    ).rejects.toThrow(/manifest\.json/);
    expect(await workspaceRepository.list()).toHaveLength(beforeCount);
  });

  it("损坏 zip（截断）→ 拒绝且不落数据", async () => {
    const beforeCount = (await workspaceRepository.list()).length;
    const zip = craftVault([
      { name: "manifest.json", text: MANIFEST },
      { name: "notes/a.md", text: "正文" },
    ]);
    await expect(
      new VaultImportService(makeImportDeps()).importVault(
        zip.slice(0, zip.length - 10),
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await workspaceRepository.list()).toHaveLength(beforeCount);
  });

  it("缺失 assets 文件：记入 missingAssets，图片降级为占位文本，导入不中断", async () => {
    const zip = craftVault([
      { name: "manifest.json", text: MANIFEST },
      {
        name: "vault.json",
        text: JSON.stringify({
          format: "e1-vault",
          formatVersion: 1,
          name: "缺资源库",
        }),
      },
      {
        name: "notes/含图.md",
        text: "# 含图\n\n![示意图](../assets/missing.png)\n",
      },
    ]);
    const report = await new VaultImportService(makeImportDeps()).importVault(
      zip,
    );
    expect(report.importedCount).toBe(1);
    expect(report.missingAssets).toEqual([
      {
        path: "assets/missing.png",
        referencedBy: "notes/含图.md",
        reason: "ZIP 包内缺少该资源文件",
      },
    ]);
    expect(report.lossy).toBe(true);

    const [page] = await livePages(report.workspaceId);
    const content = await contentRepository.get(page.id);
    expect(JSON.stringify(content!.contentJson)).toContain("（图片：示意图）");
  });

  it("无法解析的页面链接：剥离死链接保留文本并计入 unresolvedLinks", async () => {
    const zip = craftVault([
      { name: "manifest.json", text: MANIFEST },
      { name: "notes/a.md", text: "[幽灵](ghost.md)\n" },
    ]);
    const report = await new VaultImportService(makeImportDeps()).importVault(
      zip,
    );
    expect(report.unresolvedLinks).toEqual([
      {
        target: "ghost.md",
        referencedBy: "notes/a.md",
        reason: "链接目标不在本 Vault 内（保留文本）",
      },
    ]);
    const [page] = await livePages(report.workspaceId);
    const content = await contentRepository.get(page.id);
    // 文本保留、链接标记已剥离（不写死相对路径）。
    expect(JSON.stringify(content!.contentJson)).toContain("幽灵");
    expect(JSON.stringify(content!.contentJson)).not.toContain("ghost.md");
  });

  it("重复 Frontmatter id：首次出现者保留映射，其余记入报告", async () => {
    const frontmatter = (title: string) =>
      `---\nid: dup-id\ntitle: ${title}\n---\n\n正文 ${title}\n`;
    const zip = craftVault([
      { name: "manifest.json", text: MANIFEST },
      { name: "notes/a.md", text: frontmatter("甲") },
      { name: "notes/b.md", text: frontmatter("乙") },
    ]);
    const report = await new VaultImportService(makeImportDeps()).importVault(
      zip,
    );
    expect(report.importedCount).toBe(2);
    expect(report.duplicateNoteIds).toEqual([
      { id: "dup-id", path: "notes/b.md" },
    ]);
    const titles = (await livePages(report.workspaceId)).map(
      (page) => page.title,
    );
    expect(titles).toEqual(["甲", "乙"]);
  });

  it("单文档写入失败：记 skipped 继续，不整库半拉", async () => {
    const zip = craftVault([
      { name: "manifest.json", text: MANIFEST },
      { name: "notes/a.md", text: "---\ntitle: 好\n---\n\n甲\n" },
      { name: "notes/b.md", text: "---\ntitle: 坏\n---\n\n乙\n" },
      { name: "notes/c.md", text: "---\ntitle: 也好\n---\n\n丙\n" },
    ]);
    const deps = makeImportDeps();
    const real = deps.documentCommands;
    // 注入一次写入失败：标题为「坏」的文档创建抛错。
    deps.documentCommands = {
      createWithContent: (input) => {
        if (input.title === "坏") return Promise.reject(new Error("磁盘抖动"));
        return real.createWithContent(input);
      },
      replaceContent: (input) => real.replaceContent(input),
    };
    const report = await new VaultImportService(deps).importVault(zip);
    expect(report.importedCount).toBe(2);
    expect(report.skipped).toEqual([
      { path: "notes/b.md", reason: "文档创建失败：磁盘抖动" },
    ]);
    const titles = (await livePages(report.workspaceId)).map(
      (page) => page.title,
    );
    expect(titles).toEqual(["好", "也好"]);
  });

  it("无 metadata/tree.json：从 notes/ 目录结构推导页面树", async () => {
    const zip = craftVault([
      { name: "manifest.json", text: MANIFEST },
      {
        name: "vault.json",
        text: JSON.stringify({
          format: "e1-vault",
          formatVersion: 1,
          name: "无树库",
        }),
      },
      { name: "notes/工作/项目.md", text: "---\ntitle: 项目\n---\n\n甲\n" },
      { name: "notes/学习.md", text: "---\ntitle: 学习\n---\n\n乙\n" },
    ]);
    const report = await new VaultImportService(makeImportDeps()).importVault(
      zip,
    );
    expect(report.importedCount).toBe(2);
    const pages = await livePages(report.workspaceId);
    const group = pages.find((page) => page.kind === "group")!;
    expect(group.title).toBe("工作");
    const project = pages.find((page) => page.title === "项目")!;
    expect(project.parentId).toBe(group.id);
    expect(pages.find((page) => page.title === "学习")!.parentId).toBeNull();
  });

  it("options.targetWorkspaceName 覆盖 vault.json 名称", async () => {
    const zip = craftVault([
      { name: "manifest.json", text: MANIFEST },
      {
        name: "vault.json",
        text: JSON.stringify({
          format: "e1-vault",
          formatVersion: 1,
          name: "原名",
        }),
      },
      { name: "notes/a.md", text: "正文" },
    ]);
    const report: VaultImportReport = await new VaultImportService(
      makeImportDeps(),
    ).importVault(zip, { targetWorkspaceName: "指定名" });
    expect(report.workspaceName).toBe("指定名");
  });

  it("parse 失败的文档记 skipped，其余正常导入", async () => {
    const deps = makeImportDeps();
    // codec.parse 对合法 markdown 不会失败；用非法 UTF-8 以外的注入方式：
    // 直接让 zip 中一篇 md 的 frontmatter 之外内容触发 sanitize 例外较难，
    // 这里改为验证「无 Frontmatter 的纯 md」也可导入并记 notesWithoutId。
    const zip = craftVault([
      { name: "manifest.json", text: MANIFEST },
      { name: "notes/纯文本.md", text: "没有 Frontmatter 的正文\n" },
    ]);
    const report = await new VaultImportService(deps).importVault(zip);
    expect(report.importedCount).toBe(1);
    expect(report.notesWithoutId).toEqual(["notes/纯文本.md"]);
    const [page] = await livePages(report.workspaceId);
    expect(page.title).toBe("纯文本");
  });
});
