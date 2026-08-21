/**
 * R008 Stage 4（§10.5/§11.5/§11.6/§13）：Desktop 全文搜索索引服务——
 * FullTextSearchIndexPort 语义在 Main 侧的编排实现。
 *
 * 分层（§11.1 adapter 隔离）：
 *   IPC handler（electron/main/ipc/search.ts）
 *   → DesktopSearchService（状态机 + 重建编排，本文件）
 *   → DesktopSearchDatabase（node:sqlite adapter）
 *   → node:sqlite
 *
 * 状态模型（§13.1）：未知 vault → missing；prepareWorkspace 打开/创建
 * 库后 ready；首建（库不存在或损坏自愈后新建）与 rebuild 期间 building
 * （progress = 已索引/总数）；任何索引操作失败 → degraded（R8-06：绝不
 * 抛出影响正文主流程，经 getStatus 暴露，等待 rebuild 恢复）。
 *
 * 首建流程（§11.5）：打开新库 → 从注入的 SearchDocumentSource（生产为
 * Vault 扫描 VaultSearchDocumentSource）批量读入 → 250 篇/事务批量
 * upsert（§11.6 100~500 区间）→ ready。prepareWorkspace 自身等待首建
 * 完成（幂等），但调用方（Renderer 装配）fire-and-forget——building
 * 期间页面树/编辑器照常可用，搜索贡献空结果（§10.5）。
 *
 * 查询（§10.5/§10.6）：仅 ready 的 vault 参与；DB 召回候选（超集）→
 * 契约层 rankSearchDocuments 精排（权重/snippet/稳定排序/limit）。
 * vaultId 缺省时合并全部已打开 vault 的候选后全局重排。
 *
 * rebuild 语义：清空派生内容 → 从注入 source 重新载入。生产 source 是
 * Vault 扫描（正文真相）；契约测试注入「库存快照回读」source——与内存
 * 参照实现的「从留存源文档重新派生」语义等价（§17.2 双实现契约）。
 */
import type {
  SearchDocument,
  SearchIndexStatus,
  SearchQueryInput,
  SearchRebuildResult,
  SearchRemoveInput,
  SearchResult,
} from "../../../shared/search/model.js";
import {
  normalizeSearchQuery,
  rankSearchDocuments,
} from "../../../shared/search/ranking.js";
import { DesktopSearchDatabase } from "./DesktopSearchDatabase.js";

/** rebuild/首建的文档来源（正文真相提供方；生产为 Vault 扫描）。 */
export interface SearchDocumentSource {
  load(vaultId: string): Promise<SearchDocument[]>;
}

export interface DesktopSearchServiceOptions {
  /** 索引库根目录（userData/search-index；测试注入临时目录）。 */
  baseDir: string;
  /** 正文真相来源；缺省时首建/重建产出空索引（测试/降级场景）。 */
  source?: SearchDocumentSource;
  now?: () => number;
  /** 单事务批量 upsert 大小（§11.6：100~500 篇/事务）。 */
  batchSize?: number;
  /** 召回候选上限（精排前安全闸；§17 验收语料最大命中 150）。 */
  recallCap?: number;
}

interface VaultEntry {
  db: DesktopSearchDatabase;
  status: SearchIndexStatus;
}

const DEFAULT_BATCH_SIZE = 250;
const DEFAULT_RECALL_CAP = 2000;
/**
 * degraded 原因的机器可读短串——不外抛 DB 原始错误消息（可能携带本机
 * 绝对路径，§15.1：路径不出 Main）。
 */
const DEGRADED_REASON = "search-index-operation-failed";

function* batches<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}

export class DesktopSearchService {
  private readonly vaults = new Map<string, VaultEntry>();
  private readonly pending = new Map<string, Promise<VaultEntry>>();
  private readonly source?: SearchDocumentSource;
  private readonly baseDir: string;
  private readonly now: () => number;
  private readonly batchSize: number;
  private readonly recallCap: number;

  constructor(options: DesktopSearchServiceOptions) {
    this.baseDir = options.baseDir;
    this.source = options.source;
    this.now = options.now ?? (() => Date.now());
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.recallCap = options.recallCap ?? DEFAULT_RECALL_CAP;
  }

  /** 准备（必要时创建并首建）vault 索引；幂等。 */
  async prepareWorkspace(vaultId: string): Promise<void> {
    await this.ensureReady(vaultId);
  }

  async search(input: SearchQueryInput): Promise<SearchResult[]> {
    const normalized = normalizeSearchQuery(input.query);
    if (normalized === "") return [];
    const vaultIds =
      input.vaultId !== undefined ? [input.vaultId] : [...this.vaults.keys()];
    const candidates: SearchDocument[] = [];
    for (const vaultId of vaultIds) {
      const entry = this.vaults.get(vaultId);
      // missing / building / degraded 的 vault 贡献空结果（§10.5）。
      if (!entry || entry.status.state !== "ready") continue;
      try {
        candidates.push(...entry.db.recall(normalized, this.recallCap));
      } catch {
        entry.status = { state: "degraded", reason: DEGRADED_REASON };
      }
    }
    return rankSearchDocuments(candidates, input.query, input.limit);
  }

  async upsert(doc: SearchDocument): Promise<void> {
    const entry = await this.ensureReady(doc.vaultId);
    try {
      entry.db.upsertDocuments([doc]);
    } catch {
      entry.status = { state: "degraded", reason: DEGRADED_REASON };
    }
  }

  async remove(input: SearchRemoveInput): Promise<void> {
    const entry = this.vaults.get(input.vaultId);
    // 未知 vault 为 no-op（不为 remove 单独建库）。
    if (!entry) return;
    try {
      entry.db.removeDocument(input.pageId);
    } catch {
      entry.status = { state: "degraded", reason: DEGRADED_REASON };
    }
  }

  async rebuild(vaultId: string): Promise<SearchRebuildResult> {
    const startedAt = this.now();
    const entry = await this.ensureReady(vaultId);
    entry.status = { state: "building", progress: 0 };
    try {
      const docs = this.source ? await this.source.load(vaultId) : [];
      entry.db.clearAll();
      let done = 0;
      for (const batch of batches(docs, this.batchSize)) {
        entry.db.upsertDocuments(batch);
        done += batch.length;
        entry.status = {
          state: "building",
          progress: docs.length === 0 ? 1 : done / docs.length,
        };
      }
      const indexedDocuments = entry.db.countDocuments();
      entry.status = { state: "ready", indexedDocuments };
      return { indexedDocuments, durationMs: this.now() - startedAt };
    } catch {
      entry.status = { state: "degraded", reason: DEGRADED_REASON };
      return { indexedDocuments: 0, durationMs: this.now() - startedAt };
    }
  }

  async getStatus(vaultId: string): Promise<SearchIndexStatus> {
    const entry = this.vaults.get(vaultId);
    if (!entry) return { state: "missing" };
    if (entry.status.state !== "ready") return entry.status;
    // ready 计数实时取（upsert/remove 后无需维护镜像）。
    try {
      return { state: "ready", indexedDocuments: entry.db.countDocuments() };
    } catch {
      entry.status = { state: "degraded", reason: DEGRADED_REASON };
      return entry.status;
    }
  }

  /**
   * 库存源文档快照（契约测试「自派生重建」source 与诊断用）。不门控
   * 状态——rebuild 期间（building）source 回读必须仍能拿到重建前的
   * 留存文档；库未打开返回空表，读取失败进入 degraded。
   */
  async snapshotDocuments(vaultId: string): Promise<SearchDocument[]> {
    const entry = this.vaults.get(vaultId);
    if (!entry) return [];
    try {
      return entry.db.listDocuments();
    } catch {
      entry.status = { state: "degraded", reason: DEGRADED_REASON };
      return [];
    }
  }

  /** 打开（或取已打开）vault 条目；并发调用共享同一次打开+首建。 */
  private ensureReady(vaultId: string): Promise<VaultEntry> {
    const existing = this.vaults.get(vaultId);
    if (existing) return Promise.resolve(existing);
    let opening = this.pending.get(vaultId);
    if (!opening) {
      opening = this.openAndPopulate(vaultId).finally(() =>
        this.pending.delete(vaultId),
      );
      this.pending.set(vaultId, opening);
    }
    return opening;
  }

  private async openAndPopulate(vaultId: string): Promise<VaultEntry> {
    const db = DesktopSearchDatabase.open(this.baseDir, vaultId, {
      now: this.now,
    });
    const entry: VaultEntry = {
      db,
      status: { state: "ready", indexedDocuments: db.countDocuments() },
    };
    this.vaults.set(vaultId, entry);
    if (db.createdFresh) {
      await this.populateFromSource(vaultId, entry);
    }
    return entry;
  }

  /** 首建：从正文真相批量载入（§11.5/§11.6）；失败进入 degraded。 */
  private async populateFromSource(
    vaultId: string,
    entry: VaultEntry,
  ): Promise<void> {
    if (!this.source) {
      entry.status = { state: "ready", indexedDocuments: 0 };
      return;
    }
    entry.status = { state: "building", progress: 0 };
    try {
      const docs = await this.source.load(vaultId);
      let done = 0;
      for (const batch of batches(docs, this.batchSize)) {
        entry.db.upsertDocuments(batch);
        done += batch.length;
        entry.status = {
          state: "building",
          progress: docs.length === 0 ? 1 : done / docs.length,
        };
      }
      entry.status = { state: "ready", indexedDocuments: entry.db.countDocuments() };
    } catch {
      entry.status = { state: "degraded", reason: DEGRADED_REASON };
    }
  }
}
