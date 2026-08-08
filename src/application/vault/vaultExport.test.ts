/**
 * Portable Vault 导出服务测试（R005 阶段 7，批次 7A）。
 *
 * 覆盖 portable-vault.md 定稿布局与验收标准：
 * - zip 条目集合与路径（group → 文件夹、document → notes/<标题>.md）；
 * - Frontmatter 字段（id/title/tags/created/updated）与标签名解析；
 * - assets/ 资源文件与 md 相对引用路径（按目录深度计算）、字节一致；
 * - 文件名冲突确定性（项目.md / 项目 (2).md / 项目 (3).md）与
 *   固定时钟下两次导出字节级一致；
 * - 回收站页面排除、空知识库合法导出；
 * - @ 提及相对链接解析（含跨目录与无法解析降级）。
 *
 * 依赖用 IndexedDB 仓储（fake-indexeddb）直组成 VaultExportDeps 窄接口，
 * 不经种子数据所在的预置知识库，导出自建知识库即可隔离。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { INITIAL_CONTENT_VERSION_TOKEN } from "../../domain/types";
import { resetDB } from "../../infrastructure/db";
import {
  assetStore,
  contentRepository,
  pageRepository,
  tagRepository,
  workspaceRepository,
} from "../../infrastructure/repositories";
import {
  VaultExportService,
  relativePath,
  type VaultExportDeps,
} from "./VaultExportService";

const decoder = new TextDecoder();
/** 固定时钟：断言字节确定性时排除 manifest.exportedAt 的真实时间。 */
const FIXED_NOW = () => new Date("2026-08-08T12:00:00.000Z");

/** 直组窄接口依赖（不经查询服务，避免会话/搜索索引等无关装配）。 */
function makeDeps(now?: () => Date): VaultExportDeps {
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
    now,
  };
}

/** 最小 ZIP 读取器：顺序解析 local file header（STORED 条目）。 */
function readZipEntries(zip: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const entries = new Map<string, Uint8Array>();
  let offset = 0;
  while (
    offset + 30 <= zip.length &&
    view.getUint32(offset, true) === 0x04034b50
  ) {
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const size = view.getUint32(offset + 18, true);
    const name = decoder.decode(
      zip.subarray(offset + 30, offset + 30 + nameLength),
    );
    const start = offset + 30 + nameLength + extraLength;
    entries.set(name, zip.slice(start, start + size));
    offset = start + size;
  }
  return entries;
}

function entryText(entries: Map<string, Uint8Array>, name: string): string {
  const data = entries.get(name);
  if (!data) throw new Error(`zip 缺少条目：${name}`);
  return decoder.decode(data);
}

function entryJson(entries: Map<string, Uint8Array>, name: string) {
  return JSON.parse(entryText(entries, name)) as Record<string, unknown>;
}

/** 建一篇文档页并写入正文。 */
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
    // 建页时已生成空白正文记录（版本 idb:1），保存需带上当前版本令牌。
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

function paragraph(text: string) {
  return {
    type: "paragraph",
    content: [{ type: "text", text }],
  };
}

function doc(...content: unknown[]) {
  return { type: "doc", content };
}

describe("relativePath", () => {
  it("按目录深度生成相对前缀", () => {
    expect(relativePath("notes/a.md", "assets/x.png")).toBe("../assets/x.png");
    expect(relativePath("notes/工作/a.md", "assets/x.png")).toBe(
      "../../assets/x.png",
    );
    expect(relativePath("notes/工作/a.md", "notes/工作/b.md")).toBe("b.md");
    expect(relativePath("notes/工作/a.md", "notes/学习/b.md")).toBe(
      "../学习/b.md",
    );
    expect(relativePath("notes/a/b/c.md", "notes/d.md")).toBe("../../d.md");
  });
});

describe("VaultExportService", () => {
  beforeEach(async () => {
    await resetDB();
  });

  it("导出结构：group → 文件夹、document → notes/<标题>.md，元数据齐备", async () => {
    const ws = await workspaceRepository.create("我的知识库");
    const group = await pageRepository.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "group",
      title: "工作",
    });
    const docA = await createDoc(
      ws.id,
      group.id,
      "项目 A",
      doc(paragraph("甲")),
    );
    const docB = await createDoc(ws.id, null, "学习", doc(paragraph("乙")));

    const service = new VaultExportService(makeDeps(FIXED_NOW));
    const result = await service.exportWorkspace(ws.id);
    const entries = readZipEntries(result.data);

    expect(result.fileName).toBe("我的知识库.e1.zip");
    expect(result.entryNames).toEqual([...entries.keys()]);
    expect([...entries.keys()].sort()).toEqual(
      [
        "manifest.json",
        "vault.json",
        "metadata/tree.json",
        "metadata/page-map.json",
        "notes/学习.md",
        "notes/工作/",
        "notes/工作/项目 A.md",
      ].sort(),
    );

    const manifest = entryJson(entries, "manifest.json");
    expect(manifest).toMatchObject({
      format: "e1-vault",
      formatVersion: 1,
      generator: "e1-web",
      exportedAt: "2026-08-08T12:00:00.000Z",
      noteCount: 2,
      assetCount: 0,
    });

    const vault = entryJson(entries, "vault.json");
    expect(vault).toMatchObject({
      format: "e1-vault",
      formatVersion: 1,
      vaultId: ws.id,
      name: "我的知识库",
      assetsDirectory: "assets",
      identityMode: "frontmatter",
    });

    const pageMap = entryJson(entries, "metadata/page-map.json");
    // pageId → notes 路径映射只含文档页（链接重写用），group 不在其中。
    expect(pageMap.pages).toEqual({
      [docA.id]: "notes/工作/项目 A.md",
      [docB.id]: "notes/学习.md",
    });

    const tree = entryJson(entries, "metadata/tree.json");
    const treePages = tree.pages as {
      id: string;
      kind: string;
      path: string;
      position: number;
    }[];
    expect(treePages).toHaveLength(3);
    expect(treePages.find((p) => p.id === group.id)).toMatchObject({
      kind: "group",
      path: "notes/工作",
      position: 0,
    });

    expect(result.summary).toMatchObject({
      noteCount: 2,
      assetCount: 0,
      skippedTrashCount: 0,
      missingAssetCount: 0,
      lossy: false,
    });
  });

  it("Frontmatter：id/title/tags/created/updated 正确，tags 解析为标签名", async () => {
    const ws = await workspaceRepository.create("库");
    const page = await createDoc(ws.id, null, "项目 A", doc(paragraph("正文")));
    const tag = await tagRepository.create(ws.id, "重要", "#ff0000");
    await tagRepository.setPageTags(page.id, [tag.id]);

    const service = new VaultExportService(makeDeps(FIXED_NOW));
    const result = await service.exportWorkspace(ws.id);
    const md = entryText(readZipEntries(result.data), "notes/项目 A.md");

    expect(md).toContain(`id: ${page.id}`);
    expect(md).toContain("title: 项目 A");
    expect(md).toContain("tags: [重要]");
    expect(md).toContain(`created: ${new Date(page.createdAt).toISOString()}`);
    expect(md).toContain(`updated: ${new Date(page.updatedAt).toISOString()}`);
    expect(md).toContain("正文");
  });

  it("资源：localImage 与 attachment 写入 assets/，md 引用按目录深度相对", async () => {
    const ws = await workspaceRepository.create("库");
    const group = await pageRepository.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "group",
      title: "工作",
    });
    const imageBytes = new Uint8Array([1, 2, 3, 4]);
    const pdfBytes = new Uint8Array([5, 6, 7]);
    // 先建文档拿到 pageId 再挂附件，正文中按 attachmentId 引用。
    const page = await createDoc(ws.id, group.id, "含资源");
    const image = await assetStore.add({
      pageId: page.id,
      name: "image.png",
      mimeType: "image/png",
      size: imageBytes.byteLength,
      data: imageBytes,
    });
    const pdf = await assetStore.add({
      pageId: page.id,
      name: "design.pdf",
      mimeType: "application/pdf",
      size: pdfBytes.byteLength,
      data: pdfBytes,
    });
    const existing = await contentRepository.get(page.id);
    await contentRepository.save(
      page.id,
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

    const service = new VaultExportService(makeDeps(FIXED_NOW));
    const result = await service.exportWorkspace(ws.id);
    const entries = readZipEntries(result.data);

    expect([...entries.get("assets/image.png")!]).toEqual([...imageBytes]);
    expect([...entries.get("assets/design.pdf")!]).toEqual([...pdfBytes]);

    // notes/工作/含资源.md → assets/ 需要两级 ../。
    const md = entryText(entries, "notes/工作/含资源.md");
    expect(md).toContain("![示意图](../../assets/image.png)");
    expect(md).toContain("[design.pdf](../../assets/design.pdf)");
    expect(result.summary.assetCount).toBe(2);
    expect(entryJson(entries, "manifest.json").assetCount).toBe(2);
  });

  it("文件名冲突：同目录三同名文档确定性重命名，固定时钟下两次导出字节一致", async () => {
    const ws = await workspaceRepository.create("库");
    for (let i = 0; i < 3; i += 1) {
      await createDoc(ws.id, null, "项目", doc(paragraph(`第 ${i + 1} 篇`)));
    }

    const service = new VaultExportService(makeDeps(FIXED_NOW));
    const first = await service.exportWorkspace(ws.id);
    const second = await service.exportWorkspace(ws.id);
    const entries = readZipEntries(first.data);

    expect(
      ["notes/项目.md", "notes/项目 (2).md", "notes/项目 (3).md"].every((n) =>
        entries.has(n),
      ),
    ).toBe(true);
    // 创建顺序（position 升序）决定编号：最早创建的占 项目.md。
    expect(entryText(entries, "notes/项目.md")).toContain("第 1 篇");
    expect(entryText(entries, "notes/项目 (2).md")).toContain("第 2 篇");
    expect(entryText(entries, "notes/项目 (3).md")).toContain("第 3 篇");

    // 字节级确定性：exportedAt 经固定时钟排除后，两次导出完全一致。
    expect([...second.data]).toEqual([...first.data]);
  });

  it("回收站页面不导出并计数；空知识库导出为合法 zip", async () => {
    const ws = await workspaceRepository.create("库");
    const kept = await createDoc(ws.id, null, "保留", doc(paragraph("留")));
    const trashed = await createDoc(ws.id, null, "废弃", doc(paragraph("废")));
    await pageRepository.remove(trashed.id);

    const service = new VaultExportService(makeDeps(FIXED_NOW));
    const result = await service.exportWorkspace(ws.id);
    const entries = readZipEntries(result.data);

    expect(entries.has("notes/保留.md")).toBe(true);
    expect(entries.has("notes/废弃.md")).toBe(false);
    expect(result.summary.skippedTrashCount).toBe(1);
    expect(entryJson(entries, "metadata/page-map.json").pages).toEqual({
      [kept.id]: "notes/保留.md",
    });

    // 空知识库：只有元数据条目，zip 结构合法。
    const empty = await workspaceRepository.create("空库");
    const emptyResult = await service.exportWorkspace(empty.id);
    const emptyEntries = readZipEntries(emptyResult.data);
    expect([...emptyEntries.keys()].sort()).toEqual(
      [
        "manifest.json",
        "vault.json",
        "metadata/page-map.json",
        "metadata/tree.json",
      ].sort(),
    );
    expect(emptyResult.summary.noteCount).toBe(0);
    expect(entryJson(emptyEntries, "manifest.json").noteCount).toBe(0);
  });

  it("@ 提及解析为目标 md 相对链接；无法解析时降级纯文本并记录", async () => {
    const ws = await workspaceRepository.create("库");
    const group = await pageRepository.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "group",
      title: "学习",
    });
    const target = await createDoc(
      ws.id,
      group.id,
      "目标",
      doc(paragraph("的")),
    );
    await createDoc(
      ws.id,
      null,
      "来源",
      doc({
        type: "paragraph",
        content: [
          { type: "text", text: "见 " },
          { type: "mention", attrs: { id: target.id, label: "目标" } },
          { type: "text", text: " 与 " },
          { type: "mention", attrs: { id: "page-不存在", label: "幽灵" } },
        ],
      }),
    );

    const service = new VaultExportService(makeDeps(FIXED_NOW));
    const result = await service.exportWorkspace(ws.id);
    const entries = readZipEntries(result.data);

    // notes/来源.md → notes/学习/目标.md：同根相对路径。
    const md = entryText(entries, "notes/来源.md");
    expect(md).toContain("[目标](学习/目标.md)");
    // 无法解析的提及降级为纯文本 @标题，并计入 unsupported。
    expect(md).toContain("@幽灵");
    expect(result.summary.lossy).toBe(true);
    expect(
      result.summary.unsupported.some((item) => item.kind === "mention"),
    ).toBe(true);
  });

  it("知识库不存在时抛 WORKSPACE_NOT_FOUND", async () => {
    const service = new VaultExportService(makeDeps(FIXED_NOW));
    await expect(service.exportWorkspace("ws-不存在")).rejects.toMatchObject({
      code: "WORKSPACE_NOT_FOUND",
    });
  });
});
