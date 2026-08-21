// @vitest-environment node
/**
 * R008 Stage 4（§10.5/§11.5/§13.1，R8-06）：DesktopSearchService 编排
 * 测试——状态机（missing/building/ready/degraded）、首建回填、rebuild
 * 替换、跨 vault 合并、故障降级不抛出、transient vaultId 派生库名。
 * 真实 node:sqlite 临时库；source 一律注入 stub。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { SearchDocument } from "../../../shared/search/model.js";
import { DesktopSearchService } from "./DesktopSearchService.js";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeBaseDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "e1-search-svc-"));
  tempDirs.push(dir);
  return dir;
}

function doc(
  pageId: string,
  overrides: Partial<SearchDocument> = {},
): SearchDocument {
  return {
    pageId,
    vaultId: "vault-a",
    stableNoteId: null,
    relativePath: `notes/${pageId}.md`,
    title: "",
    tags: [],
    bodyText: "",
    createdAt: null,
    updatedAt: null,
    versionToken: `v1-${pageId}`,
    ...overrides,
  };
}

describe("DesktopSearchService 状态机", () => {
  it("未知 vault → missing；prepare 后 ready", async () => {
    const service = new DesktopSearchService({ baseDir: await makeBaseDir() });
    expect(await service.getStatus("vault-a")).toEqual({ state: "missing" });
    await service.prepareWorkspace("vault-a");
    expect(await service.getStatus("vault-a")).toEqual({
      state: "ready",
      indexedDocuments: 0,
    });
    // 幂等。
    await service.prepareWorkspace("vault-a");
    expect(await service.getStatus("vault-a")).toEqual({
      state: "ready",
      indexedDocuments: 0,
    });
  });

  it("首建：新库从 source 批量回填后 ready（§11.5）", async () => {
    const service = new DesktopSearchService({
      baseDir: await makeBaseDir(),
      source: {
        load: async () => [
          doc("p1", { title: "部署手册" }),
          doc("p2", { bodyText: "正文里的部署检查" }),
          doc("p3", { title: "无关" }),
        ],
      },
    });
    await service.prepareWorkspace("vault-a");
    expect(await service.getStatus("vault-a")).toEqual({
      state: "ready",
      indexedDocuments: 3,
    });
    const results = await service.search({
      vaultId: "vault-a",
      query: "部署",
      limit: 10,
    });
    expect(results.map((r) => r.pageId)).toEqual(["p1", "p2"]);
  });

  it("building 期间搜索贡献空结果，完成后可查（§10.5）", async () => {
    let release: (docs: SearchDocument[]) => void = () => undefined;
    const gate = new Promise<SearchDocument[]>((resolve) => {
      release = resolve;
    });
    const service = new DesktopSearchService({
      baseDir: await makeBaseDir(),
      source: { load: () => gate },
    });
    const preparing = service.prepareWorkspace("vault-a");
    // 打开完成后进入 building（等待 source）——先让 openAndPopulate 跑到 load。
    await Promise.resolve();
    await Promise.resolve();
    const status = await service.getStatus("vault-a");
    expect(status.state === "building" || status.state === "ready").toBe(true);
    expect(
      await service.search({ vaultId: "vault-a", query: "部署", limit: 10 }),
    ).toEqual([]);
    release([doc("p1", { title: "部署手册" })]);
    await preparing;
    expect(await service.getStatus("vault-a")).toEqual({
      state: "ready",
      indexedDocuments: 1,
    });
    expect(
      (
        await service.search({ vaultId: "vault-a", query: "部署", limit: 10 })
      ).map((r) => r.pageId),
    ).toEqual(["p1"]);
  });

  it("source 首建失败 → degraded；修复后 rebuild 恢复 ready（R8-06 不抛出）", async () => {
    let docs: SearchDocument[] | null = null;
    const service = new DesktopSearchService({
      baseDir: await makeBaseDir(),
      source: {
        load: async () => {
          if (docs === null) throw new Error("vault 暂不可读");
          return docs;
        },
      },
    });
    await service.prepareWorkspace("vault-a");
    expect((await service.getStatus("vault-a")).state).toBe("degraded");
    docs = [doc("p1", { title: "部署手册" })];
    const rebuilt = await service.rebuild("vault-a");
    expect(rebuilt.indexedDocuments).toBe(1);
    expect(await service.getStatus("vault-a")).toEqual({
      state: "ready",
      indexedDocuments: 1,
    });
  });

  it("rebuild 用 source 全量替换库存", async () => {
    const sourceDocs = [doc("p1", { title: "部署手册" })];
    const service = new DesktopSearchService({
      baseDir: await makeBaseDir(),
      source: { load: async () => sourceDocs },
    });
    await service.prepareWorkspace("vault-a");
    sourceDocs.length = 0;
    sourceDocs.push(doc("p2", { title: "全新文档" }));
    const rebuilt = await service.rebuild("vault-a");
    expect(rebuilt.indexedDocuments).toBe(1);
    expect(
      await service.search({ vaultId: "vault-a", query: "部署", limit: 10 }),
    ).toEqual([]);
    expect(
      (
        await service.search({
          vaultId: "vault-a",
          query: "全新",
          limit: 10,
        })
      ).map((r) => r.pageId),
    ).toEqual(["p2"]);
  });

  it("已存在的库重开不再回填（source 不再调用）", async () => {
    const baseDir = await makeBaseDir();
    let loadCalls = 0;
    const makeService = () =>
      new DesktopSearchService({
        baseDir,
        source: {
          load: async () => {
            loadCalls += 1;
            return [doc("p1", { title: "部署手册" })];
          },
        },
      });
    await makeService().prepareWorkspace("vault-a");
    expect(loadCalls).toBe(1);
    const reopened = makeService();
    await reopened.prepareWorkspace("vault-a");
    expect(loadCalls).toBe(1);
    expect(await reopened.getStatus("vault-a")).toEqual({
      state: "ready",
      indexedDocuments: 1,
    });
  });

  it("transient:<uuid> 形式的 vaultId 可正常建库与查询", async () => {
    const service = new DesktopSearchService({
      baseDir: await makeBaseDir(),
      source: { load: async () => [doc("p1", { title: "预览文档" })] },
    });
    const vaultId = "transient:abcd-1234";
    await service.prepareWorkspace(vaultId);
    expect(await service.getStatus(vaultId)).toEqual({
      state: "ready",
      indexedDocuments: 1,
    });
    expect(
      (
        await service.search({ vaultId, query: "预览", limit: 10 })
      ).map((r) => r.pageId),
    ).toEqual(["p1"]);
  });

  it("跨 vault 合并查询按全局得分重排", async () => {
    const service = new DesktopSearchService({ baseDir: await makeBaseDir() });
    await service.prepareWorkspace("vault-a");
    await service.prepareWorkspace("vault-b");
    await service.upsert(doc("a-body", { bodyText: "正文里的共享词" }));
    await service.upsert(
      doc("b-title", { vaultId: "vault-b", title: "共享词 标题" }),
    );
    const results = await service.search({ query: "共享词", limit: 10 });
    expect(results.map((r) => r.pageId)).toEqual(["b-title", "a-body"]);
  });

  it("remove 对未知 vault 为 no-op 且不占库", async () => {
    const service = new DesktopSearchService({ baseDir: await makeBaseDir() });
    await service.remove({ vaultId: "vault-unknown", pageId: "p1" });
    expect(await service.getStatus("vault-unknown")).toEqual({
      state: "missing",
    });
  });
});
