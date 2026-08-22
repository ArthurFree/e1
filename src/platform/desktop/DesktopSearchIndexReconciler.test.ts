/**
 * R008 Stage 5（§12）：DesktopSearchIndexReconciler 测试——
 * 归一化事件 → 索引动作映射（created/modified upsert、moved relocate、
 * deleted noteKey/relativePath）、自写提交、失败降级 + 延迟重建调度。
 */
import { describe, expect, it, vi } from "vitest";
import type {
  E1DesktopAPI,
  SearchIndexStatus,
  VaultScanResult,
} from "./desktopApi";
import { DesktopIdentityAliasRegistry } from "./DesktopIdentityAliasRegistry";
import { DesktopSearchIndex } from "./DesktopSearchIndex";
import { DesktopSearchIndexReconciler } from "./DesktopSearchIndexReconciler";
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
  const search = {
    query: vi.fn(async () => []),
    rebuild: vi.fn(async () => ({ indexedDocuments: 1 })),
    upsert: vi.fn(async () => ({ indexed: true })),
    remove: vi.fn(async () => {}),
    relocate: vi.fn(async () => {}),
    status: vi.fn(async (): Promise<SearchIndexStatus> => ({
      state: "ready",
      indexedDocuments: 1,
    })),
  };
  const api = {
    vault: { scan: vi.fn(async () => SCAN) },
    search,
  } as unknown as E1DesktopAPI;
  const scans = new DesktopVaultScanCache(api);
  const aliases = new DesktopIdentityAliasRegistry();
  const fullText = new DesktopSearchIndex(api, scans);
  const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
  const reconciler = new DesktopSearchIndexReconciler({
    api,
    scans,
    aliases,
    fullText,
    schedule: (fn, delayMs) => scheduled.push({ fn, delayMs }),
  });
  return { api, search, scans, aliases, fullText, reconciler, scheduled };
}

describe("DesktopSearchIndexReconciler（R008 §12）", () => {
  it("created / modified → search.upsert（扫描快照解析路径）", async () => {
    const { search, scans, reconciler } = setup();
    await scans.scan("v1");
    await reconciler.reconcile([
      { type: "created", vaultId: "v1", pageId: "01JABC" },
      { type: "modified", vaultId: "v1", pageId: "01JABC" },
    ]);
    expect(search.upsert).toHaveBeenCalledTimes(2);
    expect(search.upsert).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "学习/React.md",
    });
  });

  it("moved → search.relocate（事件 from/to，身份保持）", async () => {
    const { search, reconciler } = setup();
    await reconciler.reconcile([
      {
        type: "moved",
        vaultId: "v1",
        pageId: "01JABC",
        from: "学习/React.md",
        to: "归档/React.md",
      },
    ]);
    expect(search.relocate).toHaveBeenCalledWith({
      vaultId: "v1",
      from: "学习/React.md",
      to: "归档/React.md",
    });
  });

  it("deleted：stable id（含 Adoption 别名）→ noteKey 删除；path 身份 → relativePath", async () => {
    const { search, aliases, reconciler } = setup();
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
    expect(search.remove).toHaveBeenCalledWith({
      vaultId: "v1",
      noteKey: "01ADOPTED",
    });
    expect(search.remove).toHaveBeenCalledWith({
      vaultId: "v1",
      noteKey: "01JABC",
    });
    expect(search.remove).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "杂记/x.md",
    });
  });

  it("自写提交（onDocumentCommitted）→ search.upsert（§12.4 不依赖 watcher）", async () => {
    const { search, scans, reconciler } = setup();
    await scans.scan("v1");
    await reconciler.onDocumentCommitted("01JABC");
    expect(search.upsert).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "学习/React.md",
    });
  });

  it("索引动作失败 → degraded + 调度一次延迟 rebuild（§12.5/R8-06，不抛错）", async () => {
    const { search, fullText, scans, reconciler, scheduled } = setup();
    await scans.scan("v1");
    search.upsert.mockRejectedValueOnce(new Error("sqlite busy"));
    // reconcile 不抛错（正文保存不受影响）。
    await reconciler.reconcile([
      { type: "modified", vaultId: "v1", pageId: "01JABC" },
    ]);
    expect(fullText.getStatus("v1").state).toBe("degraded");
    expect(scheduled).toHaveLength(1);
    // 触发调度的延迟 rebuild：恢复 ready。
    scheduled[0].fn();
    await vi.waitFor(() =>
      expect(fullText.getStatus("v1").state).toBe("ready"),
    );
  });

  it("事件驱动 prepare：状态 missing 的库先重建再应用事件", async () => {
    const { search, scans, reconciler } = setup();
    await scans.scan("v1");
    search.status.mockResolvedValue({ state: "missing" });
    await reconciler.reconcile([
      { type: "modified", vaultId: "v1", pageId: "01JABC" },
    ]);
    expect(search.rebuild).toHaveBeenCalledWith({ vaultId: "v1" });
    expect(search.upsert).toHaveBeenCalled();
  });
});
