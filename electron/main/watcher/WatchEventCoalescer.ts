/**
 * R007 阶段 3（DSK-02）：chokidar 原始事件的按 vault 聚合与静止窗口合并。
 *
 * VaultWatcher 把分类后的原始事件 push 进来；同一 vault 在静止窗口
 * （默认 150ms，最后一个事件到达后无新事件）到期时 flush 一次，产出
 * 去重/合并后的 VaultFsEvent[] 交给广播层。
 *
 * 合并规则（按 category+relativePath 归并，保留首见顺序）：
 * - 同 path 同类事件去重（add+add → add，change+change → change）；
 * - 同 path add+change → add（新建后立刻被写仍算新建）；
 * - 同 path add 后 unlink → 两者抵消（窗口内新建又删除，对外等于没发生）；
 * - 同 path unlink 后 add → change（删除后原地重建视为修改）；
 * - change 后 unlink → unlink。
 *
 * 降级：单 vault 单批待合并事件数超过阈值（默认 500，验收 7 的「海量事件」
 * 防线）时丢弃整批细节，只发一条 {type:"rescan-required"}；.e1/vault.json
 * 变化（vault-meta 类）同样只产 rescan-required——重扫语义已覆盖其余事件，
 * 同批其他事件一并省略。
 */
import type { VaultFsEvent } from "../../../shared/ipc/contracts.js";

/** 静止窗口默认值（ms）。 */
export const COALESCE_WINDOW_MS = 150;

/** 单 vault 单批事件数阈值：超过即降级为 rescan-required。 */
export const COALESCE_MAX_BATCH_EVENTS = 500;

/** watcher 原始事件（已由 VaultWatcher 完成分类，未合并）。 */
export interface RawWatchEvent {
  vaultId: string;
  /** chokidar 三类文件事件。 */
  kind: "add" | "change" | "unlink";
  category: "note" | "asset" | "vault-meta";
  /** POSIX 风格相对路径；vault-meta 类固定为 ".e1/vault.json"。 */
  relativePath: string;
}

export interface WatchEventCoalescerOptions {
  windowMs?: number;
  maxBatchEvents?: number;
}

interface PendingVault {
  events: RawWatchEvent[];
  /** 已超阈值：整批降级 rescan-required，后续事件不再记录细节。 */
  overflow: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/** 归并用的内部状态：add/change/unlink 之一，或已抵消。 */
type MergeState = "add" | "change" | "unlink" | "cancelled";

export class WatchEventCoalescer {
  private readonly windowMs: number;
  private readonly maxBatchEvents: number;
  private readonly pending = new Map<string, PendingVault>();

  constructor(
    private readonly onFlush: (vaultId: string, events: VaultFsEvent[]) => void,
    options: WatchEventCoalescerOptions = {},
  ) {
    this.windowMs = options.windowMs ?? COALESCE_WINDOW_MS;
    this.maxBatchEvents = options.maxBatchEvents ?? COALESCE_MAX_BATCH_EVENTS;
  }

  /** 推入一条原始事件；重置该 vault 的静止窗口计时。 */
  push(event: RawWatchEvent): void {
    let slot = this.pending.get(event.vaultId);
    if (!slot) {
      slot = { events: [], overflow: false, timer: null };
      this.pending.set(event.vaultId, slot);
    }
    if (!slot.overflow) {
      slot.events.push(event);
      if (slot.events.length > this.maxBatchEvents) {
        slot.events = [];
        slot.overflow = true;
      }
    }
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = setTimeout(() => this.flush(event.vaultId), this.windowMs);
  }

  /** 立即合并并发出某 vault 的待处理事件（无待处理则什么都不做）。 */
  flush(vaultId: string): void {
    const slot = this.pending.get(vaultId);
    if (!slot) return;
    if (slot.timer) clearTimeout(slot.timer);
    this.pending.delete(vaultId);
    const events = slot.overflow
      ? [{ type: "rescan-required", vaultId } satisfies VaultFsEvent]
      : mergeEvents(vaultId, slot.events);
    if (events.length > 0) this.onFlush(vaultId, events);
  }

  /** 清空全部待处理事件与计时器（closeAll / 测试清理用）。 */
  dispose(): void {
    for (const slot of this.pending.values()) {
      if (slot.timer) clearTimeout(slot.timer);
    }
    this.pending.clear();
  }
}

/** 单 vault 一批原始事件 → 去重合并后的 VaultFsEvent[]（保持首见顺序）。 */
export function mergeEvents(
  vaultId: string,
  events: RawWatchEvent[],
): VaultFsEvent[] {
  // vault-meta：rescan 语义覆盖一切，整批只剩一条 rescan-required。
  if (events.some((e) => e.category === "vault-meta")) {
    return [{ type: "rescan-required", vaultId }];
  }

  const order: string[] = [];
  const states = new Map<string, { state: MergeState; category: "note" | "asset" }>();
  for (const event of events) {
    // vault-meta 已在函数开头整批降级为 rescan-required。
    if (event.category === "vault-meta") continue;
    const key = `${event.category} ${event.relativePath}`;
    const existing = states.get(key);
    if (!existing) {
      order.push(key);
      states.set(key, { state: event.kind, category: event.category });
      continue;
    }
    existing.state = mergeState(existing.state, event.kind);
  }

  const result: VaultFsEvent[] = [];
  for (const key of order) {
    const entry = states.get(key)!;
    if (entry.state === "cancelled") continue;
    const relativePath = key.slice(key.indexOf(" ") + 1);
    if (entry.category === "asset") {
      // 资产不区分细类：任何存活变化统一 asset-changed。
      result.push({ type: "asset-changed", vaultId, relativePath });
    } else if (entry.state === "add") {
      result.push({ type: "note-created", vaultId, relativePath });
    } else if (entry.state === "unlink") {
      result.push({ type: "note-removed", vaultId, relativePath });
    } else {
      result.push({ type: "note-changed", vaultId, relativePath });
    }
  }
  return result;
}

/** 同 path 状态机：上一状态 × 新事件 → 合并状态。 */
function mergeState(prev: MergeState, next: "add" | "change" | "unlink"): MergeState {
  switch (prev) {
    case "add":
      // add+add 去重；add+change 仍是新建；add 后删除 → 抵消。
      return next === "unlink" ? "cancelled" : "add";
    case "change":
      // change+add（罕见，按修改处理）；change+change 去重；change 后删除 → 删除。
      return next === "unlink" ? "unlink" : "change";
    case "unlink":
      // 删除后原地重建 → 修改；其余保持删除。
      return next === "add" ? "change" : "unlink";
    case "cancelled":
      // 已抵消后又出现事件：新建视为 add，其余按新事件重新起算。
      return next;
  }
}
