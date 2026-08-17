/**
 * R007 阶段 3（DSK-02，r007 §3.3）：DesktopExternalVaultChangeService 测试。
 *
 * 假 api 捕获 subscribeVaultChanges 的 listener（手动 emit 事件批次）；
 * 假 scans 以可控的新旧快照驱动 diff。覆盖：
 * - 静止窗口批量合并（100 个事件只触发一次 scan/rescan）；
 * - rename → moved（stable noteId 相同）/ 无 id rename → deleted+created；
 * - created / deleted / modified 分类与 created+modified、modified+deleted
 *   合并规则；
 * - rescan-required / asset-changed 只触发重扫，无 diff 不通知；
 * - scan/rescan 失败 console.warn 静默降级；stop 取消订阅并丢弃缓冲；
 * - moved 发布前同步来源缓存的过期路径（含 Adoption 会话别名，r007 §3.4）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  VaultFsEvent,
  VaultScanEntry,
  VaultScanResult,
} from "../../../shared/ipc/contracts";
import type { E1DesktopAPI } from "./desktopApi";
import type { ExternalDocumentChange } from "../../application/services/ExternalVaultChangeService";
import { DesktopExternalVaultChangeService } from "./DesktopExternalVaultChangeService";
import { DesktopDocumentSourceCache } from "./DesktopDocumentSourceCache";
import { DesktopIdentityAliasRegistry } from "./DesktopIdentityAliasRegistry";
import type { DesktopVaultScanCache } from "./DesktopVaultScanCache";

const VAULT = "v1";

function doc(
  relativePath: string,
  noteId: string | null = null,
): VaultScanEntry {
  return {
    noteId,
    relativePath,
    kind: "document",
    title: relativePath,
    parentPath: null,
    tags: [],
  };
}

function scanResult(entries: VaultScanEntry[]): VaultScanResult {
  return { vault: { vaultId: VAULT, name: "库" }, entries };
}

interface FakeScans {
  scan: ReturnType<typeof vi.fn>;
  rescan: ReturnType<typeof vi.fn>;
}

function fakeScans(
  before: VaultScanEntry[],
  after: VaultScanEntry[],
): DesktopVaultScanCache & FakeScans {
  return {
    scan: vi.fn(async () => ({ result: scanResult(before), scannedAt: 1 })),
    rescan: vi.fn(async () => ({ result: scanResult(after), scannedAt: 2 })),
  } as unknown as DesktopVaultScanCache & FakeScans;
}

interface Harness {
  service: DesktopExternalVaultChangeService;
  emit: (events: VaultFsEvent[]) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
  scans: DesktopVaultScanCache & FakeScans;
  received: ExternalDocumentChange[][];
}

function harness(before: VaultScanEntry[], after: VaultScanEntry[]): Harness {
  let emit: (events: VaultFsEvent[]) => void = () => {};
  const unsubscribe = vi.fn();
  const api = {
    events: {
      subscribeVaultChanges: vi.fn(
        (listener: (events: VaultFsEvent[]) => void) => {
          emit = listener;
          return unsubscribe;
        },
      ),
    },
  } as unknown as E1DesktopAPI;
  const scans = fakeScans(before, after);
  const service = new DesktopExternalVaultChangeService({ api, scans });
  const received: ExternalDocumentChange[][] = [];
  service.subscribe((changes) => received.push(changes));
  service.start();
  return { service, emit: (e) => emit(e), unsubscribe, scans, received };
}

/** 静止窗口到期 + 处理链（scan/rescan）微任务全部落定。 */
async function flushBatch() {
  await vi.advanceTimersByTimeAsync(200);
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("DesktopExternalVaultChangeService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("静止窗口合并：100 个事件只触发一次 scan + 一次 rescan", async () => {
    const h = harness([doc("a.md", "01A")], [doc("a.md", "01A")]);
    // 分多批到达（每批都重置静止窗口），共 100 个 note-changed。
    for (let i = 0; i < 10; i += 1) {
      h.emit(
        Array.from({ length: 10 }, () => ({
          type: "note-changed" as const,
          vaultId: VAULT,
          relativePath: "a.md",
        })),
      );
      await vi.advanceTimersByTimeAsync(50);
    }
    await flushBatch();
    expect(h.scans.scan).toHaveBeenCalledTimes(1);
    expect(h.scans.rescan).toHaveBeenCalledTimes(1);
    // 同路径 note-changed 去重为一条 modified。
    expect(h.received).toEqual([
      [{ type: "modified", vaultId: VAULT, pageId: "01A" }],
    ]);
  });

  it("rename（stable noteId 相同）→ moved，pageId 取自新快照条目", async () => {
    const h = harness([doc("旧名.md", "01X")], [doc("新名.md", "01X")]);
    h.emit([
      { type: "note-removed", vaultId: VAULT, relativePath: "旧名.md" },
      { type: "note-created", vaultId: VAULT, relativePath: "新名.md" },
    ]);
    await flushBatch();
    expect(h.received).toEqual([
      [
        {
          type: "moved",
          vaultId: VAULT,
          pageId: "01X",
          from: "旧名.md",
          to: "新名.md",
        },
      ],
    ]);
  });

  it("rename（无 stable id）→ deleted + created（身份随路径变化）", async () => {
    const h = harness([doc("旧名.md")], [doc("新名.md")]);
    h.emit([
      { type: "note-removed", vaultId: VAULT, relativePath: "旧名.md" },
      { type: "note-created", vaultId: VAULT, relativePath: "新名.md" },
    ]);
    await flushBatch();
    expect(h.received).toEqual([
      [
        { type: "deleted", vaultId: VAULT, pageId: "path:旧名.md" },
        { type: "created", vaultId: VAULT, pageId: "path:新名.md" },
      ],
    ]);
  });

  it("created：新快照多出条目（无 id 文档 pageId 为 path 派生）", async () => {
    const h = harness([], [doc("n.md")]);
    h.emit([{ type: "note-created", vaultId: VAULT, relativePath: "n.md" }]);
    await flushBatch();
    expect(h.received).toEqual([
      [{ type: "created", vaultId: VAULT, pageId: "path:n.md" }],
    ]);
  });

  it("deleted：新快照缺失条目", async () => {
    const h = harness([doc("d.md", "01D")], []);
    h.emit([{ type: "note-removed", vaultId: VAULT, relativePath: "d.md" }]);
    await flushBatch();
    expect(h.received).toEqual([
      [{ type: "deleted", vaultId: VAULT, pageId: "01D" }],
    ]);
  });

  it("note-changed → modified；新快照已无该路径则跳过", async () => {
    const h = harness(
      [doc("a.md", "01A"), doc("b.md", "01B")],
      [doc("a.md", "01A")],
    );
    h.emit([
      { type: "note-changed", vaultId: VAULT, relativePath: "a.md" },
      // 改后即删：b.md 在新快照已不存在，不产生 modified（deleted 覆盖）。
      { type: "note-changed", vaultId: VAULT, relativePath: "b.md" },
      { type: "note-removed", vaultId: VAULT, relativePath: "b.md" },
    ]);
    await flushBatch();
    expect(h.received).toEqual([
      [
        { type: "deleted", vaultId: VAULT, pageId: "01B" },
        { type: "modified", vaultId: VAULT, pageId: "01A" },
      ],
    ]);
  });

  it("合并规则：同 pageId created+modified → created", async () => {
    const h = harness([], [doc("n.md", "01N")]);
    h.emit([
      { type: "note-created", vaultId: VAULT, relativePath: "n.md" },
      { type: "note-changed", vaultId: VAULT, relativePath: "n.md" },
    ]);
    await flushBatch();
    expect(h.received).toEqual([
      [{ type: "created", vaultId: VAULT, pageId: "01N" }],
    ]);
  });

  it("合并规则：同 pageId modified+deleted → deleted", async () => {
    const h = harness([doc("d.md", "01D")], []);
    h.emit([
      { type: "note-changed", vaultId: VAULT, relativePath: "d.md" },
      { type: "note-removed", vaultId: VAULT, relativePath: "d.md" },
    ]);
    await flushBatch();
    expect(h.received).toEqual([
      [{ type: "deleted", vaultId: VAULT, pageId: "01D" }],
    ]);
  });

  it("纯 rescan-required 无结构性 diff：触发重扫但不通知", async () => {
    const h = harness([doc("a.md", "01A")], [doc("a.md", "01A")]);
    h.emit([{ type: "rescan-required", vaultId: VAULT }]);
    await flushBatch();
    expect(h.scans.rescan).toHaveBeenCalledTimes(1);
    expect(h.received).toEqual([]);
  });

  it("rescan-required 有结构性 diff：照常发布变更", async () => {
    const h = harness([], [doc("n.md", "01N")]);
    h.emit([{ type: "rescan-required", vaultId: VAULT }]);
    await flushBatch();
    expect(h.received).toEqual([
      [{ type: "created", vaultId: VAULT, pageId: "01N" }],
    ]);
  });

  it("asset-changed：只触发重扫，不产生文档变更通知", async () => {
    const h = harness([doc("a.md", "01A")], [doc("a.md", "01A")]);
    h.emit([
      { type: "asset-changed", vaultId: VAULT, relativePath: "assets/x.png" },
    ]);
    await flushBatch();
    expect(h.scans.rescan).toHaveBeenCalledTimes(1);
    expect(h.received).toEqual([]);
  });

  it("多 vault 同批：分组各自串行处理，分别通知", async () => {
    // 假 scans 对两个 vault 返回同一组快照（无结构性 diff）。
    const h = harness([doc("a.md", "01A")], [doc("a.md", "01A")]);
    h.emit([
      { type: "note-changed", vaultId: VAULT, relativePath: "a.md" },
      { type: "note-changed", vaultId: "v2", relativePath: "a.md" },
    ]);
    await flushBatch();
    expect(h.scans.scan).toHaveBeenCalledWith(VAULT);
    expect(h.scans.scan).toHaveBeenCalledWith("v2");
    expect(h.scans.rescan).toHaveBeenCalledTimes(2);
    expect(h.received).toEqual([
      [{ type: "modified", vaultId: VAULT, pageId: "01A" }],
      [{ type: "modified", vaultId: "v2", pageId: "01A" }],
    ]);
  });

  it("scan/rescan 失败：console.warn 静默降级，不通知、不抛出", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = harness([], [doc("n.md")]);
      h.scans.rescan.mockRejectedValueOnce(new Error("vault 不可达"));
      h.emit([{ type: "rescan-required", vaultId: VAULT }]);
      await flushBatch();
      expect(h.received).toEqual([]);
      expect(warn).toHaveBeenCalled();
      // 后续批次不受影响。
      h.emit([{ type: "note-created", vaultId: VAULT, relativePath: "n.md" }]);
      await flushBatch();
      expect(h.received).toEqual([
        [{ type: "created", vaultId: VAULT, pageId: "path:n.md" }],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("stop：取消事件订阅并丢弃未处理缓冲；再次 start 可恢复", async () => {
    const h = harness([], [doc("n.md", "01N")]);
    h.emit([{ type: "note-created", vaultId: VAULT, relativePath: "n.md" }]);
    h.service.stop();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    await flushBatch();
    // 缓冲被丢弃：不触发 scan/rescan、不通知。
    expect(h.scans.scan).not.toHaveBeenCalled();
    expect(h.received).toEqual([]);

    h.service.start();
    h.emit([{ type: "note-created", vaultId: VAULT, relativePath: "n.md" }]);
    await flushBatch();
    expect(h.received).toEqual([
      [{ type: "created", vaultId: VAULT, pageId: "01N" }],
    ]);
  });

  it("start 幂等：重复调用只订阅一次", () => {
    const h = harness([], []);
    h.service.start();
    h.service.start();
    h.service.stop();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("moved 发布前同步来源缓存路径（含 Adoption 会话别名，R007 §3.4）", async () => {
    const sources = new DesktopDocumentSourceCache();
    sources.set("01X", {
      vaultId: VAULT,
      sessionPageId: "01X",
      relativePath: "旧名.md",
      stableNoteId: "01X",
      metadata: { id: "01X", title: "t", tags: [], aliases: [] },
      frontmatterExtra: [],
      lineEnding: "lf",
      hadUtf8Bom: false,
      versionToken: "sha256:v",
      compatibility: { lossy: false, unsupported: [] },
      writeSession: {
        sourceLossyApproved: false,
        outputLossyApproved: false,
        identityAdoptionApproved: false,
      },
    });
    // Adoption 会话：源缓存键为 path:* 会话 id，经别名按 stable noteId 找到。
    sources.set("path:旧别名.md", {
      vaultId: VAULT,
      sessionPageId: "path:旧别名.md",
      relativePath: "旧别名.md",
      stableNoteId: "01Y",
      metadata: { id: "01Y", title: "y", tags: [], aliases: [] },
      frontmatterExtra: [],
      lineEnding: "lf",
      hadUtf8Bom: false,
      versionToken: "sha256:v",
      compatibility: { lossy: false, unsupported: [] },
      writeSession: {
        sourceLossyApproved: false,
        outputLossyApproved: false,
        identityAdoptionApproved: false,
      },
    });
    const aliases = new DesktopIdentityAliasRegistry();
    aliases.register({
      vaultId: VAULT,
      sessionPageId: "path:旧别名.md",
      stableNoteId: "01Y",
      relativePath: "旧别名.md",
    });
    const h = harness(
      [doc("旧名.md", "01X"), doc("旧别名.md", "01Y")],
      [doc("新名.md", "01X"), doc("新别名.md", "01Y")],
    );
    // 重新构造带 sources/aliases 的服务（harness 默认不带）。
    h.service.stop();
    let emit: (events: VaultFsEvent[]) => void = () => {};
    const api = {
      events: {
        subscribeVaultChanges: vi.fn(
          (listener: (events: VaultFsEvent[]) => void) => {
            emit = listener;
            return () => {};
          },
        ),
      },
    } as unknown as E1DesktopAPI;
    const service = new DesktopExternalVaultChangeService({
      api,
      scans: h.scans,
      sources,
      aliases,
    });
    const received: ExternalDocumentChange[][] = [];
    service.subscribe((changes) => received.push(changes));
    service.start();
    emit([
      { type: "note-removed", vaultId: VAULT, relativePath: "旧名.md" },
      { type: "note-created", vaultId: VAULT, relativePath: "新名.md" },
      { type: "note-removed", vaultId: VAULT, relativePath: "旧别名.md" },
      { type: "note-created", vaultId: VAULT, relativePath: "新别名.md" },
    ]);
    await flushBatch();
    expect(received.flat().map((c) => c.type)).toEqual(["moved", "moved"]);
    expect(sources.get("01X")?.relativePath).toBe("新名.md");
    expect(sources.get("path:旧别名.md")?.relativePath).toBe("新别名.md");
  });
});
