/**
 * R007 阶段 3（DSK-02，r007 §3.3）：Renderer 侧外部变更 reconciliation。
 *
 * 职责链：Main Watcher 事件（VaultFsEvent 批次，只含 vaultId + 相对路径
 * 事实）→ 静止窗口批量合并 → 按 vault 分组串行处理 → 旧快照（缓存命中
 * 不发 IPC）+ 强制重扫新快照 → 快照 diff + watcher 事实归并为
 * ExternalDocumentChange → 通知订阅方（页面树刷新桥等）。
 *
 * 归并规则（条目身份与 vaultMapping.pageIdOfEntry 同口径：document 优先
 * Frontmatter stable noteId，缺失时 path:<relativePath>）：
 * - 结构性 diff 以身份为准：新快照有而旧快照无 → created；反之 → deleted；
 *   身份相同但 relativePath 变化 → moved（stable-id 文件 rename：watcher
 *   的 note-removed(oldPath)+note-created(newPath) 在此归并为一条 moved；
 *   无 stable id 的 rename 身份随路径变化，自然落为 deleted+created）；
 * - note-changed → modified（pageId 从新快照该路径条目派生；新快照已无
 *   该路径——如改后即删——跳过，deleted 已覆盖）；
 * - 合并：created+modified → created；modified+deleted → deleted；
 *   moved 与 modified 同现时 moved 优先（树位置变化必须刷新）；
 * - rescan-required / asset-changed 只承担 invalidate+rescan（rescan 内部
 *   已含 invalidate）：结构性 diff 仍可能产出变更；无 diff 则不通知——
 *   listener 只收非空批次；asset 变化本期不通知文档层（r007 §3.3）。
 *
 * 失败降级：scan/rescan 失败（vault 不可达等）console.warn 后跳过本批次，
 * 不抛出、不影响后续批次。同 vault 处理经 Promise 链串行，避免并发重扫
 * 交错（扫描缓存本身也共享并发 Promise，双保险）。
 */
import type {
  ExternalDocumentChange,
  ExternalVaultChangeService,
} from "../../application/services/ExternalVaultChangeService";
import type {
  VaultFsEvent,
  VaultScanEntry,
} from "../../../shared/ipc/contracts";
import type { E1DesktopAPI } from "./desktopApi";
import type { DesktopVaultScanCache } from "./DesktopVaultScanCache";
import type { DesktopDocumentSourceCache } from "./DesktopDocumentSourceCache";
import type { DesktopIdentityAliasRegistry } from "./DesktopIdentityAliasRegistry";
import { pageIdOfEntry } from "./vaultMapping";

/** 默认静止窗口（ms）：窗口内持续到达的事件合并为一批处理。 */
const DEFAULT_BATCH_MS = 200;

export interface DesktopExternalVaultChangeServiceDeps {
  api: E1DesktopAPI;
  scans: DesktopVaultScanCache;
  /**
   * 打开文档的来源缓存（R007 §3.4）：moved 变更发布前同步其中过期
   * 的 relativePath，避免下次保存写回旧路径。可选——缺省时跳过同步。
   */
  sources?: DesktopDocumentSourceCache;
  /**
   * 会话身份别名（R006-C4.1-B）：Adoption 后会话 pageId 仍为 path:*，
   * moved 变更的 pageId 是 stable noteId，需经别名找到源缓存键。
   */
  aliases?: DesktopIdentityAliasRegistry;
  /** 静止窗口毫秒数；缺省 200（测试可注入更小值）。 */
  batchMs?: number;
}

/**
 * 事件批次 + 新旧快照 → 归一化文档变更（归并规则见文件头注释）。
 * 纯函数，group 条目不产生文档变更。
 */
function diffExternalDocumentChanges(
  vaultId: string,
  events: VaultFsEvent[],
  oldEntries: VaultScanEntry[],
  newEntries: VaultScanEntry[],
): ExternalDocumentChange[] {
  const oldDocs = new Map<string, VaultScanEntry>();
  for (const entry of oldEntries) {
    if (entry.kind === "document") oldDocs.set(pageIdOfEntry(entry), entry);
  }
  const newDocs = new Map<string, VaultScanEntry>();
  const newByPath = new Map<string, VaultScanEntry>();
  for (const entry of newEntries) {
    if (entry.kind !== "document") continue;
    newDocs.set(pageIdOfEntry(entry), entry);
    newByPath.set(entry.relativePath, entry);
  }

  const changes = new Map<string, ExternalDocumentChange>();
  // deleted：旧快照有、新快照无（identity 维度）。
  for (const [pageId] of oldDocs) {
    if (!newDocs.has(pageId)) {
      changes.set(pageId, { type: "deleted", vaultId, pageId });
    }
  }
  // created / moved：新快照有、旧快照无 → created；身份相同但路径变化 → moved。
  for (const [pageId, entry] of newDocs) {
    const prev = oldDocs.get(pageId);
    if (!prev) {
      changes.set(pageId, { type: "created", vaultId, pageId });
    } else if (prev.relativePath !== entry.relativePath) {
      changes.set(pageId, {
        type: "moved",
        vaultId,
        pageId,
        from: prev.relativePath,
        to: entry.relativePath,
      });
    }
  }
  // modified：watcher note-changed 事实；结构性变更（created/moved/deleted）
  // 已覆盖的 pageId 不重复记 modified。
  for (const event of events) {
    if (event.type !== "note-changed") continue;
    const entry = newByPath.get(event.relativePath);
    if (!entry) continue;
    const pageId = pageIdOfEntry(entry);
    if (changes.has(pageId)) continue;
    changes.set(pageId, { type: "modified", vaultId, pageId });
  }
  return [...changes.values()];
}

export class DesktopExternalVaultChangeService implements ExternalVaultChangeService {
  private readonly api: E1DesktopAPI;
  private readonly scans: DesktopVaultScanCache;
  private readonly sources?: DesktopDocumentSourceCache;
  private readonly aliases?: DesktopIdentityAliasRegistry;
  private readonly batchMs: number;
  private buffer: VaultFsEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly listeners = new Set<
    (changes: ExternalDocumentChange[]) => void
  >();
  /** 同 vault 处理串行链（processVault 内部吞错，链不拒签）。 */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(deps: DesktopExternalVaultChangeServiceDeps) {
    this.api = deps.api;
    this.scans = deps.scans;
    this.sources = deps.sources;
    this.aliases = deps.aliases;
    this.batchMs = deps.batchMs ?? DEFAULT_BATCH_MS;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.api.events.subscribeVaultChanges((events) =>
      this.enqueue(events),
    );
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buffer = [];
  }

  subscribe(listener: (changes: ExternalDocumentChange[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 事件进缓冲并重置静止窗口；窗口到期后统一 flush。 */
  private enqueue(events: VaultFsEvent[]): void {
    if (events.length === 0) return;
    this.buffer.push(...events);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.batchMs);
  }

  /** 缓冲批次按 vault 分组，逐 vault 串行处理。 */
  private flush(): void {
    const batch = this.buffer;
    this.buffer = [];
    const byVault = new Map<string, VaultFsEvent[]>();
    for (const event of batch) {
      const list = byVault.get(event.vaultId);
      if (list) list.push(event);
      else byVault.set(event.vaultId, [event]);
    }
    for (const [vaultId, events] of byVault) {
      const prev = this.chains.get(vaultId) ?? Promise.resolve();
      const next = prev.then(() => this.processVault(vaultId, events));
      this.chains.set(vaultId, next);
    }
  }

  private async processVault(
    vaultId: string,
    events: VaultFsEvent[],
  ): Promise<void> {
    try {
      // 旧快照取缓存（会话已加载时不发 IPC）；随后强制重扫拿新快照
      //（rescan 内部已含 invalidate——asset-changed / rescan-required 的
      // 缓存失效语义由此覆盖，无需单独处理）。
      const before = await this.scans.scan(vaultId);
      const after = await this.scans.rescan(vaultId);
      const changes = diffExternalDocumentChanges(
        vaultId,
        events,
        before.result.entries,
        after.result.entries,
      );
      // 纯 rescan-required / asset-changed 等无文档 diff 的批次不通知。
      if (changes.length > 0) {
        for (const change of changes) {
          if (change.type === "moved") this.syncMovedSourcePath(change);
        }
        this.publish(changes);
      }
    } catch (err) {
      console.warn(`处理外部 Vault 变更失败（${vaultId}），已跳过本批次`, err);
    }
  }

  /**
   * moved 变更发布前同步来源缓存的过期 relativePath（R007 §3.4）：
   * 保存与 Mention/资源相对路径解析以源缓存路径为准，不同步会把下次
   * 保存写回旧路径。Adoption 会话（pageId 为 stable noteId、源缓存键
   * 为 path:* 会话 id）经别名一并处理。
   */
  private syncMovedSourcePath(change: { pageId: string; to: string }): void {
    if (!this.sources) return;
    this.sources.updateRelativePath(change.pageId, change.to);
    const alias = this.aliases?.getByStableNoteId(change.pageId);
    if (alias) {
      this.sources.updateRelativePath(alias.sessionPageId, change.to);
    }
  }

  private publish(changes: ExternalDocumentChange[]): void {
    for (const listener of this.listeners) listener(changes);
  }
}
