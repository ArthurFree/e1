/**
 * R010 Stage 4（§12）：DesktopLinkIndexReconciler 测试——
 * 归一化事件 → 链接索引动作映射（created/modified upsert、moved relocate、
 * deleted noteKey/relativePath）、自写提交、indexed=false 收口、
 * 失败降级 + 延迟重建调度。
 */
import { describe, expect, it, vi } from "vitest";
import type { SearchIndexStatus, VaultScanResult } from "./desktopApi";
import { createMockDesktopApi } from "../../test/createMockDesktopApi";
import { DesktopIdentityAliasRegistry } from "./DesktopIdentityAliasRegistry";
import { DesktopLinkIndex } from "./DesktopLinkIndex";
import { DesktopLinkIndexReconciler } from "./DesktopLinkIndexReconciler";
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
      tags: [],
    },
  ],
};

function setup() {
  const links = {
    outgoing: vi.fn(async () => []),
    backlinks: vi.fn(async () => []),
    broken: vi.fn(async () => []),
    rebuild: vi.fn(async () => ({ indexedDocuments: 1 })),
    upsert: vi.fn(async () => ({ indexed: true })),
    remove: vi.fn(async () => {}),
    relocate: vi.fn(async () => {}),
    status: vi.fn(async (): Promise<SearchIndexStatus> => ({
      state: "ready",
      indexedDocuments: 1,
    })),
  };
  // R009 Stage 0.3：统一工厂，覆盖 scan 与 links 组。
  const api = createMockDesktopApi({
    vault: { scan: vi.fn(async () => SCAN) },
    links,
  });
  const scans = new DesktopVaultScanCache(api);
  const aliases = new DesktopIdentityAliasRegistry();
  const linkIndex = new DesktopLinkIndex(api, scans);
  const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
  const reconciler = new DesktopLinkIndexReconciler({
    api,
    scans,
    aliases,
    linkIndex,
    schedule: (fn, delayMs) => scheduled.push({ fn, delayMs }),
  });
  return { api, links, scans, aliases, linkIndex, reconciler, scheduled };
}

describe("DesktopLinkIndexReconciler（R010 §12）", () => {
  it("created / modified → links.upsert（扫描快照解析路径）", async () => {
    const { links, scans, reconciler } = setup();
    await scans.scan("v1");
    await reconciler.reconcile([
      { type: "created", vaultId: "v1", pageId: "01JABC" },
      { type: "modified", vaultId: "v1", pageId: "01JABC" },
    ]);
    expect(links.upsert).toHaveBeenCalledTimes(2);
    expect(links.upsert).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "学习/React.md",
    });
  });

  it("moved → links.relocate（事件 from/to + 已知稳定键，身份保持）", async () => {
    const { links, reconciler } = setup();
    await reconciler.reconcile([
      {
        type: "moved",
        vaultId: "v1",
        pageId: "01JABC",
        from: "学习/React.md",
        to: "归档/React.md",
      },
      {
        type: "moved",
        vaultId: "v1",
        pageId: "path:杂记/x.md",
        from: "杂记/x.md",
        to: "归档/x.md",
      },
    ]);
    expect(links.relocate).toHaveBeenCalledWith({
      vaultId: "v1",
      noteKey: "01JABC",
      fromRelativePath: "学习/React.md",
      toRelativePath: "归档/React.md",
    });
    // path 身份无稳定键：省略 noteKey，按 fromRelativePath 定位。
    expect(links.relocate).toHaveBeenCalledWith({
      vaultId: "v1",
      noteKey: undefined,
      fromRelativePath: "杂记/x.md",
      toRelativePath: "归档/x.md",
    });
  });

  it("deleted：stable id（含 Adoption 别名）→ noteKey 删除；path 身份 → relativePath", async () => {
    const { links, aliases, reconciler } = setup();
    aliases.register({
      vaultId: "v1",
      sessionPageId: "path:学习/旧.md",
      stableNoteId: "01ADOPTED",
      relativePath: "学习/旧.md",
    });
    await reconciler.reconcile([
      { type: "deleted", vaultId: "v1", pageId: "path:学习/旧.md" },
      { type: "deleted", vaultId: "v1", pageId: "01JABC" },
      { type: "deleted", vaultId: "v1", pageId: "path:杂记/x.md" },
    ]);
    expect(links.remove).toHaveBeenCalledWith({
      vaultId: "v1",
      noteKey: "01ADOPTED",
    });
    expect(links.remove).toHaveBeenCalledWith({
      vaultId: "v1",
      noteKey: "01JABC",
    });
    expect(links.remove).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "杂记/x.md",
    });
  });

  it("自写提交（onDocumentCommitted）→ links.upsert（§12 不依赖 watcher）", async () => {
    const { links, scans, reconciler } = setup();
    await scans.scan("v1");
    await reconciler.onDocumentCommitted("01JABC");
    expect(links.upsert).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "学习/React.md",
    });
  });

  it("upsert 返回 indexed=false（文件已消失）→ 自动补 remove 收口", async () => {
    const { links, scans, reconciler } = setup();
    await scans.scan("v1");
    links.upsert.mockResolvedValueOnce({ indexed: false });
    await reconciler.reconcile([
      { type: "modified", vaultId: "v1", pageId: "01JABC" },
    ]);
    expect(links.remove).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "学习/React.md",
    });
  });

  it("索引动作失败 → degraded + 调度一次延迟 rebuild（§12，不抛错）", async () => {
    const { links, linkIndex, scans, reconciler, scheduled } = setup();
    await scans.scan("v1");
    links.upsert.mockRejectedValueOnce(new Error("sqlite busy"));
    // reconcile 不抛错（正文保存不受影响）。
    await reconciler.reconcile([
      { type: "modified", vaultId: "v1", pageId: "01JABC" },
    ]);
    expect(linkIndex.getStatus("v1").state).toBe("degraded");
    expect(scheduled).toHaveLength(1);
    // 触发调度的延迟 rebuild：恢复 ready。
    scheduled[0].fn();
    await vi.waitFor(() =>
      expect(linkIndex.getStatus("v1").state).toBe("ready"),
    );
  });

  it("事件驱动 prepare：状态 missing 的库先重建再应用事件", async () => {
    const { links, scans, reconciler } = setup();
    await scans.scan("v1");
    links.status.mockResolvedValue({ state: "missing" });
    await reconciler.reconcile([
      { type: "modified", vaultId: "v1", pageId: "01JABC" },
    ]);
    expect(links.rebuild).toHaveBeenCalledWith({ vaultId: "v1" });
    expect(links.upsert).toHaveBeenCalled();
  });
});
