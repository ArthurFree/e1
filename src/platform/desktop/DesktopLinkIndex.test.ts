/**
 * R010 Stage 3：DesktopLinkIndex（IPC-backed LinkIndex）测试——
 * 调用转发、upsert 竞态收口、状态镜像、markDegraded、prepare 触发重建。
 * R010 Stage 7：Adoption 身份翻译——查询入参的会话页面 id → Main 稳定键、
 * 结果行的 sourcePageId/targetPageId → 会话页面 id（别名解析）。
 */
import { describe, expect, it, vi } from "vitest";
import type { Backlink, DocumentLink } from "../../application/links/LinkIndex";
import type { SearchIndexStatus } from "./desktopApi";
import { createMockDesktopApi } from "../../test/createMockDesktopApi";
import { DesktopLinkIndex } from "./DesktopLinkIndex";
import { DesktopVaultScanCache } from "./DesktopVaultScanCache";

function mockApi() {
  const links = {
    outgoing: vi.fn(async (): Promise<DocumentLink[]> => [
      {
        sourcePageId: "01A",
        href: "乙.md",
        label: "到乙",
        kind: "internal" as const,
        targetPageId: "path:乙.md",
        targetRelativePath: "乙.md",
        fragment: null,
        broken: false,
        sourceVersion: "sha256:a",
      },
    ]),
    backlinks: vi.fn(async (): Promise<Backlink[]> => []),
    broken: vi.fn(async (): Promise<DocumentLink[]> => []),
    rebuild: vi.fn(async () => ({ indexedDocuments: 2 })),
    upsert: vi.fn(async () => ({ indexed: true })),
    remove: vi.fn(async () => {}),
    relocate: vi.fn(async () => {}),
    status: vi.fn(async (): Promise<SearchIndexStatus> => ({
      state: "ready",
      indexedDocuments: 2,
    })),
  };
  const api = createMockDesktopApi({ links });
  const scans = new DesktopVaultScanCache(api);
  return { api, links, scans };
}

describe("DesktopLinkIndex", () => {
  it("查询转发：outgoing/backlinks/broken 原样透传（无别名时恒等翻译）", async () => {
    const { api, links, scans } = mockApi();
    const index = new DesktopLinkIndex(api, scans);
    const outgoing = await index.getOutgoing({ vaultId: "v1", noteKey: "01A" });
    expect(links.outgoing).toHaveBeenCalledWith({
      vaultId: "v1",
      noteKey: "01A",
    });
    expect(outgoing[0]).toMatchObject({ targetPageId: "path:乙.md" });
    await index.getBacklinks({ vaultId: "v1", noteKey: "01A" });
    expect(links.backlinks).toHaveBeenCalledWith({
      vaultId: "v1",
      noteKey: "01A",
    });
    await index.getBrokenLinks("v1");
    expect(links.broken).toHaveBeenCalledWith({ vaultId: "v1" });
  });

  it("rebuild / refreshStatus：状态镜像更新", async () => {
    const { api, links, scans } = mockApi();
    const index = new DesktopLinkIndex(api, scans);
    expect(index.getStatus("v1").state).toBe("missing");
    await index.rebuild("v1");
    expect(links.rebuild).toHaveBeenCalledWith({ vaultId: "v1" });
    expect(index.getStatus("v1")).toEqual({
      state: "ready",
      indexedDocuments: 2,
    });
    links.status.mockResolvedValueOnce({ state: "building", progress: 1 });
    await index.refreshStatus("v1");
    expect(index.getStatus("v1")).toEqual({ state: "building", progress: 1 });
  });

  it("prepare：missing 时先刷新状态再触发 rebuild；ready 为 no-op", async () => {
    const { api, links, scans } = mockApi();
    links.status.mockResolvedValueOnce({ state: "missing" });
    const index = new DesktopLinkIndex(api, scans);
    await index.prepare("v1");
    expect(links.status).toHaveBeenCalledWith({ vaultId: "v1" });
    expect(links.rebuild).toHaveBeenCalledWith({ vaultId: "v1" });
    await index.prepare("v1");
    expect(links.rebuild).toHaveBeenCalledTimes(1);
  });

  it("upsert：文件已消失（indexed=false）时按删除收口", async () => {
    const { api, links, scans } = mockApi();
    links.upsert.mockResolvedValueOnce({ indexed: false });
    const index = new DesktopLinkIndex(api, scans);
    const result = await index.upsert({ vaultId: "v1", relativePath: "甲.md" });
    expect(result).toEqual({ indexed: false });
    expect(links.remove).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "甲.md",
    });
  });

  it("remove / relocate 转发；markDegraded 状态表达", async () => {
    const { api, links, scans } = mockApi();
    const index = new DesktopLinkIndex(api, scans);
    await index.remove({ vaultId: "v1", noteKey: "01A" });
    expect(links.remove).toHaveBeenCalledWith({
      vaultId: "v1",
      noteKey: "01A",
    });
    await index.relocate({
      vaultId: "v1",
      fromRelativePath: "甲.md",
      toRelativePath: "归档/甲.md",
    });
    expect(links.relocate).toHaveBeenCalledWith({
      vaultId: "v1",
      fromRelativePath: "甲.md",
      toRelativePath: "归档/甲.md",
    });
    index.markDegraded("v1", new Error("sqlite busy"));
    expect(index.getStatus("v1")).toEqual({
      state: "degraded",
      reason: "sqlite busy",
    });
  });

  it("Adoption 后：会话 path:* id 查询翻译为 stableNoteId，结果译回会话 id", async () => {
    const { api, links, scans } = mockApi();
    // 同会话 Stable ID Adoption：会话页面 id 保持 path:*，索引行以
    // stableNoteId 为键（DesktopIdentityAliasRegistry 记录映射）。
    scans.aliases.register({
      vaultId: "v1",
      sessionPageId: "path:甲.md",
      stableNoteId: "01ADOPTED",
      relativePath: "甲.md",
    });
    scans.aliases.register({
      vaultId: "v1",
      sessionPageId: "path:乙.md",
      stableNoteId: "01TARGET",
      relativePath: "乙.md",
    });
    links.outgoing.mockResolvedValueOnce([
      {
        sourcePageId: "01ADOPTED",
        href: "乙.md",
        label: "到乙",
        kind: "internal" as const,
        targetPageId: "01TARGET",
        targetRelativePath: "乙.md",
        fragment: null,
        broken: false,
        sourceVersion: "sha256:a",
      },
    ]);
    links.backlinks.mockResolvedValueOnce([
      {
        sourcePageId: "01TARGET",
        targetPageId: "01ADOPTED",
        sourceTitle: "乙",
        snippet: null,
        href: "甲.md",
      },
    ]);
    const index = new DesktopLinkIndex(api, scans);

    const outgoing = await index.getOutgoing({
      vaultId: "v1",
      noteKey: "path:甲.md",
    });
    expect(links.outgoing).toHaveBeenCalledWith({
      vaultId: "v1",
      noteKey: "01ADOPTED",
    });
    expect(outgoing[0]).toMatchObject({
      sourcePageId: "path:甲.md",
      targetPageId: "path:乙.md",
    });

    const backlinks = await index.getBacklinks({
      vaultId: "v1",
      noteKey: "path:甲.md",
    });
    expect(links.backlinks).toHaveBeenCalledWith({
      vaultId: "v1",
      noteKey: "01ADOPTED",
    });
    expect(backlinks[0]).toMatchObject({
      sourcePageId: "path:乙.md",
      targetPageId: "path:甲.md",
    });
  });

  it("Adoption 后：broken 列表与 remove/relocate 的 noteKey 同样翻译", async () => {
    const { api, links, scans } = mockApi();
    scans.aliases.register({
      vaultId: "v1",
      sessionPageId: "path:甲.md",
      stableNoteId: "01ADOPTED",
      relativePath: "甲.md",
    });
    links.broken.mockResolvedValueOnce([
      {
        sourcePageId: "01ADOPTED",
        href: "不存在.md",
        label: "断链",
        kind: "internal" as const,
        targetPageId: null,
        targetRelativePath: "不存在.md",
        fragment: null,
        broken: true,
        sourceVersion: "sha256:b",
      },
    ]);
    const index = new DesktopLinkIndex(api, scans);

    const broken = await index.getBrokenLinks("v1");
    expect(broken[0]).toMatchObject({
      sourcePageId: "path:甲.md",
      targetPageId: null,
    });

    await index.remove({ vaultId: "v1", noteKey: "path:甲.md" });
    expect(links.remove).toHaveBeenCalledWith({
      vaultId: "v1",
      noteKey: "01ADOPTED",
    });
    await index.relocate({
      vaultId: "v1",
      noteKey: "path:甲.md",
      fromRelativePath: "甲.md",
      toRelativePath: "归档/甲.md",
    });
    expect(links.relocate).toHaveBeenCalledWith({
      vaultId: "v1",
      noteKey: "01ADOPTED",
      fromRelativePath: "甲.md",
      toRelativePath: "归档/甲.md",
    });
  });

  it("其他 vault 的别名不参与翻译（vaultId 隔离）", async () => {
    const { api, links, scans } = mockApi();
    scans.aliases.register({
      vaultId: "v-other",
      sessionPageId: "path:甲.md",
      stableNoteId: "01ADOPTED",
      relativePath: "甲.md",
    });
    const index = new DesktopLinkIndex(api, scans);
    await index.getOutgoing({ vaultId: "v1", noteKey: "path:甲.md" });
    expect(links.outgoing).toHaveBeenCalledWith({
      vaultId: "v1",
      noteKey: "path:甲.md",
    });
  });
});
