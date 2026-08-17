// @vitest-environment node
/**
 * R007 阶段 3：WatchEventCoalescer 测试——静止窗口、去重合并规则、降级。
 * 纯 JS 计时器，使用 vi.useFakeTimers。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultFsEvent } from "../../../shared/ipc/contracts.js";
import {
  mergeEvents,
  WatchEventCoalescer,
  type RawWatchEvent,
} from "./WatchEventCoalescer.js";

function note(
  kind: RawWatchEvent["kind"],
  relativePath: string,
  vaultId = "v1",
): RawWatchEvent {
  return { vaultId, kind, category: "note", relativePath };
}

function asset(
  kind: RawWatchEvent["kind"],
  relativePath: string,
  vaultId = "v1",
): RawWatchEvent {
  return { vaultId, kind, category: "asset", relativePath };
}

describe("mergeEvents（纯函数合并规则）", () => {
  it("同 path 同类事件去重", () => {
    expect(mergeEvents("v1", [note("change", "a.md"), note("change", "a.md")])).toEqual([
      { type: "note-changed", vaultId: "v1", relativePath: "a.md" },
    ]);
  });

  it("同 path add+change → note-created", () => {
    expect(mergeEvents("v1", [note("add", "a.md"), note("change", "a.md")])).toEqual([
      { type: "note-created", vaultId: "v1", relativePath: "a.md" },
    ]);
  });

  it("add 后 unlink → 抵消（无事件）", () => {
    expect(mergeEvents("v1", [note("add", "a.md"), note("unlink", "a.md")])).toEqual([]);
  });

  it("unlink 后 add → note-changed", () => {
    expect(mergeEvents("v1", [note("unlink", "a.md"), note("add", "a.md")])).toEqual([
      { type: "note-changed", vaultId: "v1", relativePath: "a.md" },
    ]);
  });

  it("change 后 unlink → note-removed", () => {
    expect(mergeEvents("v1", [note("change", "a.md"), note("unlink", "a.md")])).toEqual([
      { type: "note-removed", vaultId: "v1", relativePath: "a.md" },
    ]);
  });

  it("asset 任意存活变化 → asset-changed；add+unlink 仍抵消", () => {
    expect(mergeEvents("v1", [asset("unlink", "assets/a.png")])).toEqual([
      { type: "asset-changed", vaultId: "v1", relativePath: "assets/a.png" },
    ]);
    expect(
      mergeEvents("v1", [asset("add", "assets/a.png"), asset("unlink", "assets/a.png")]),
    ).toEqual([]);
  });

  it("note 与 asset 同 path 不互相合并；不同 path 保持首见顺序", () => {
    expect(
      mergeEvents("v1", [
        note("change", "b.md"),
        asset("add", "b.md"),
        note("add", "a.md"),
      ]),
    ).toEqual([
      { type: "note-changed", vaultId: "v1", relativePath: "b.md" },
      { type: "asset-changed", vaultId: "v1", relativePath: "b.md" },
      { type: "note-created", vaultId: "v1", relativePath: "a.md" },
    ]);
  });

  it("含 vault-meta → 整批只剩 rescan-required", () => {
    expect(
      mergeEvents("v1", [
        note("change", "a.md"),
        { vaultId: "v1", kind: "change", category: "vault-meta", relativePath: ".e1/vault.json" },
        asset("add", "assets/a.png"),
      ]),
    ).toEqual([{ type: "rescan-required", vaultId: "v1" }]);
  });
});

describe("WatchEventCoalescer（静止窗口与降级）", () => {
  let flushed: VaultFsEvent[][];
  let coalescer: WatchEventCoalescer;

  beforeEach(() => {
    vi.useFakeTimers();
    flushed = [];
    coalescer = new WatchEventCoalescer((_vaultId, events) => {
      flushed.push(events);
    });
  });

  afterEach(() => {
    coalescer.dispose();
    vi.useRealTimers();
  });

  it("静止窗口内的事件合并为一批 flush", () => {
    coalescer.push(note("add", "a.md"));
    vi.advanceTimersByTime(50);
    coalescer.push(note("change", "a.md"));
    vi.advanceTimersByTime(149);
    expect(flushed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(flushed).toEqual([
      [{ type: "note-created", vaultId: "v1", relativePath: "a.md" }],
    ]);
  });

  it("不同 vault 独立计时、独立 flush", () => {
    coalescer.push(note("add", "a.md", "v1"));
    coalescer.push(note("add", "b.md", "v2"));
    vi.advanceTimersByTime(150);
    expect(flushed).toEqual([
      [{ type: "note-created", vaultId: "v1", relativePath: "a.md" }],
      [{ type: "note-created", vaultId: "v2", relativePath: "b.md" }],
    ]);
  });

  it("整批抵消后不发送空批次", () => {
    coalescer.push(note("add", "a.md"));
    coalescer.push(note("unlink", "a.md"));
    vi.advanceTimersByTime(150);
    expect(flushed).toEqual([]);
  });

  it("超阈值 → 降级为单条 rescan-required", () => {
    coalescer = new WatchEventCoalescer(
      (_vaultId, events) => flushed.push(events),
      { maxBatchEvents: 10 },
    );
    for (let i = 0; i < 11; i += 1) {
      coalescer.push(note("add", `n${i}.md`));
    }
    vi.advanceTimersByTime(150);
    expect(flushed).toEqual([[{ type: "rescan-required", vaultId: "v1" }]]);
  });
});
