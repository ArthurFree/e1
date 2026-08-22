/**
 * R008 Stage 4：DesktopSearchIndex（IPC-backed FullTextSearchIndex）测试——
 * 调用转发、稳定键 → 会话 id 翻译（Adoption 别名）、upsert 竞态收口、
 * remove/relocate 路径派生、状态镜像。
 */
import { describe, expect, it, vi } from "vitest";
import type { E1DesktopAPI, SearchIndexStatus, VaultScanResult } from "./desktopApi";
import { DesktopSearchIndex } from "./DesktopSearchIndex";
import { DesktopVaultScanCache } from "./DesktopVaultScanCache";

const SCAN: VaultScanResult = {
  vault: { vaultId: "v1", name: "笔记" },
  entries: [
    {
      noteId: "01JABC",
      relativePath: "学习/React.md",
      kind: "document",
      title: "React 笔记",
      parentPath: "学习",
      tags: ["前端"],
    },
  ],
};

function mockApi() {
  const search = {
    query: vi.fn(async () => [
      {
        pageId: "01JABC",
        title: "React 笔记",
        matchedField: "body" as const,
        snippet: "…组件化…",
        score: 20,
        relativePath: "学习/React.md",
        stableNoteId: "01JABC",
      },
    ]),
    rebuild: vi.fn(async () => ({ indexedDocuments: 1 })),
    upsert: vi.fn(async () => ({ indexed: true })),
    remove: vi.fn(async () => {}),
    relocate: vi.fn(async () => {}),
    status: vi.fn(
      async (): Promise<SearchIndexStatus> => ({
        state: "ready",
        indexedDocuments: 1,
      }),
    ),
  };
  const api = {
    vault: { scan: vi.fn(async () => SCAN) },
    search,
  } as unknown as E1DesktopAPI;
  return { api, search };
}

describe("DesktopSearchIndex", () => {
  it("search：转发查询并把稳定键翻译为会话页面 id（无别名时原样）", async () => {
    const { api, search } = mockApi();
    const scans = new DesktopVaultScanCache(api);
    await scans.scan("v1");
    const index = new DesktopSearchIndex(api, scans);
    const results = await index.search({ vaultId: "v1", query: "组件化" });
    expect(search.query).toHaveBeenCalledWith({
      vaultId: "v1",
      query: "组件化",
    });
    expect(results).toEqual([
      {
        pageId: "01JABC",
        title: "React 笔记",
        matchedField: "body",
        snippet: "…组件化…",
        score: 20,
        relativePath: "学习/React.md",
      },
    ]);
  });

  it("search：Adoption 别名翻译——稳定键 → 会话 path:* id", async () => {
    const { api } = mockApi();
    const scans = new DesktopVaultScanCache(api);
    await scans.scan("v1");
    scans.aliases.register({
      vaultId: "v1",
      sessionPageId: "path:学习/React.md",
      stableNoteId: "01JABC",
      relativePath: "学习/React.md",
    });
    const index = new DesktopSearchIndex(api, scans);
    const results = await index.search({ vaultId: "v1", query: "组件化" });
    expect(results[0].pageId).toBe("path:学习/React.md");
  });

  it("rebuild / refreshStatus：状态镜像更新", async () => {
    const { api, search } = mockApi();
    const index = new DesktopSearchIndex(api, new DesktopVaultScanCache(api));
    expect(index.getStatus("v1").state).toBe("missing");
    await index.rebuild("v1");
    expect(search.rebuild).toHaveBeenCalledWith({ vaultId: "v1" });
    expect(index.getStatus("v1")).toEqual({
      state: "ready",
      indexedDocuments: 1,
    });
    search.status.mockResolvedValueOnce({ state: "building", progress: 3 });
    await index.refreshStatus("v1");
    expect(index.getStatus("v1")).toEqual({ state: "building", progress: 3 });
  });

  it("upsert：文件已消失（indexed=false）时按删除收口", async () => {
    const { api, search } = mockApi();
    search.upsert.mockResolvedValueOnce({ indexed: false });
    const index = new DesktopSearchIndex(api, new DesktopVaultScanCache(api));
    await index.upsert({
      pageId: "01JABC",
      vaultId: "v1",
      stableNoteId: "01JABC",
      relativePath: "学习/React.md",
      title: "t",
      tags: [],
      bodyText: "",
      createdAt: null,
      updatedAt: null,
      versionToken: "sha256:x",
    });
    expect(search.remove).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "学习/React.md",
    });
  });

  it("remove / relocate：pageId → 相对路径派生（扫描缓存索引 + path: 回退）", async () => {
    const { api, search } = mockApi();
    const scans = new DesktopVaultScanCache(api);
    await scans.scan("v1");
    const index = new DesktopSearchIndex(api, scans);
    await index.remove({ vaultId: "v1", pageId: "01JABC" });
    expect(search.remove).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "学习/React.md",
    });
    await index.relocate({
      vaultId: "v1",
      pageId: "path:杂记/x.md",
      relativePath: "杂记/y.md",
    });
    expect(search.relocate).toHaveBeenCalledWith({
      vaultId: "v1",
      from: "杂记/x.md",
      to: "杂记/y.md",
    });
  });
});
