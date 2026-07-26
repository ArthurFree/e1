/**
 * 保存协调器（R003 阶段 1）：单文档保存的串行队列与代次（generation）管理。
 *
 * 解决的问题：
 * - 旧实现中防抖触发、flush、重试可并发执行 doSave，乱序完成时旧内容
 *   覆盖新内容，且旧保存会把仍有未保存内容的 UI 误报为「已保存」；
 * - 旧快照的孤儿附件清理会误删新快照引用的附件。
 *
 * 核心规则（R003 §1.1）：
 * 1. 每次编辑 generation + 1（noteEdit）；
 * 2. 同一文档所有保存串行执行；
 * 3. 队列中只保留最新尚未执行的快照；
 * 4. 旧 generation 保存完成后不发布 saved；
 * 5. 只有最新 generation 保存成功时才执行附件清理与间隔版本；
 * 6. 保存失败后保留最新快照用于重试。
 *
 * 仓储经构造函数注入（domain port），本模块不依赖 IndexedDB 具体实现。
 */
import type {
  AttachmentRepository,
  ContentRepository,
  RevisionRepository,
} from "../../domain/repositories";
import {
  INTERVAL_REVISION_KEEP,
  shouldCreateIntervalRevision,
} from "../../domain/revisions";
import { collectAttachmentIds } from "../../editor/attachment";
import { increment, trackTiming } from "../devDiagnostics";
import type { DocumentRecoveryRecord } from "./documentRecovery";

/** 待保存快照；generation 由协调器在入队时盖章。 */
export interface SaveSnapshot {
  pageId: string;
  generation: number;
  contentJson: unknown;
  textSnapshot: string;
}

export interface SaveResult {
  generation: number;
  savedAt: number;
}

export type SaveStatus = "saved" | "dirty" | "saving" | "error";

export interface SaveCoordinatorState {
  status: SaveStatus;
  savedAt: number | null;
}

/** 恢复缓冲抽象：生产实现为 localStorage（documentRecovery），测试可注入内存版。 */
export interface RecoveryStore {
  write(record: DocumentRecoveryRecord): void;
  clear(pageId: string, savedGeneration: number): void;
}

export interface SaveCoordinatorDeps {
  content: ContentRepository;
  revisions: RevisionRepository;
  attachments: AttachmentRepository;
  /** 可选恢复缓冲；每次入队写、保存成功清。 */
  recovery?: RecoveryStore;
  /**
   * 保存成功回调（R003 阶段 7：搜索索引增量更新）。
   * 串行队列保证按提交顺序触发，最后一次携带最新文本。
   */
  onSaved?(pageId: string, textSnapshot: string, savedAt: number): void;
  onStateChange?(state: SaveCoordinatorState): void;
}

interface Waiter {
  generation: number;
  resolve(result: SaveResult): void;
  reject(reason: unknown): void;
}

/**
 * 单文档保存协调器。每个文档一个实例；文档关闭时 dispose。
 * 所有公共方法均可重入，内部通过 running 链保证保存串行。
 */
export class DocumentSaveCoordinator {
  private generation = 0;
  private savedGeneration = 0;
  private pending: SaveSnapshot | null = null;
  private running: Promise<void> | null = null;
  private lastFailed: SaveSnapshot | null = null;
  private disposed = false;
  private waiters: Waiter[] = [];
  private idleWaiters: (() => void)[] = [];
  private lastIntervalAt: number | null = null;
  private state: SaveCoordinatorState = { status: "saved", savedAt: null };
  /** 上一个 interval 版本时间的异步回填（取代原组件内的 lastIntervalAtRef）。 */
  private readonly initPromise: Promise<void>;

  constructor(
    private readonly pageId: string,
    private readonly deps: SaveCoordinatorDeps,
  ) {
    this.initPromise = deps.revisions
      .listByPage(pageId)
      .then((list) => {
        this.lastIntervalAt =
          list.find((r) => r.reason === "interval")?.createdAt ?? null;
      })
      .catch(() => {
        // 版本时间回填失败仅影响自动版本节流，不阻塞保存主流程。
      });
  }

  /** 当前状态（React 侧订阅 onStateChange 即可，此方法供测试与初始化读取）。 */
  getState(): SaveCoordinatorState {
    return this.state;
  }

  /** 每次编辑调用：代次 +1 并发布 dirty；旧保存此后完成不得再发布 saved。 */
  noteEdit(): void {
    this.generation += 1;
    this.publish({ ...this.state, status: "dirty" });
  }

  /**
   * 提交保存快照（取当前代次盖章）。队列只保留最新快照：
   * 尚未执行的旧快照被替换，其等待者随更新快照的保存完成而兑现。
   */
  enqueue(input: { contentJson: unknown; textSnapshot: string }): Promise<SaveResult> {
    if (this.disposed) {
      return Promise.reject(new Error("保存协调器已销毁"));
    }
    const snapshot: SaveSnapshot = {
      pageId: this.pageId,
      generation: this.generation,
      contentJson: input.contentJson,
      textSnapshot: input.textSnapshot,
    };
    this.pending = snapshot;
    // 开发诊断：保存队列长度（1 = 无排队积压，R003 阶段 8）。
    increment("save-queue", this.running ? "2+" : "1");
    this.deps.recovery?.write({
      pageId: this.pageId,
      contentJson: snapshot.contentJson,
      generation: snapshot.generation,
      timestamp: Date.now(),
    });
    this.ensureRunning();
    return new Promise<SaveResult>((resolve, reject) => {
      this.waiters.push({ generation: snapshot.generation, resolve, reject });
    });
  }

  /** 等待队列排空（无挂起快照且无在途保存）。 */
  flush(): Promise<void> {
    if (!this.running && !this.pending) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  /** 保存失败后重试最新内容：优先执行队列中的更新快照，否则重跑最近失败快照。 */
  retryLatest(): Promise<SaveResult> {
    if (this.disposed) {
      return Promise.reject(new Error("保存协调器已销毁"));
    }
    if (!this.pending && this.lastFailed) {
      this.pending = this.lastFailed;
    }
    this.lastFailed = null;
    const generation = this.pending?.generation ?? this.generation;
    this.ensureRunning();
    return new Promise<SaveResult>((resolve, reject) => {
      this.waiters.push({ generation, resolve, reject });
    });
  }

  hasPending(): boolean {
    return this.pending !== null || this.running !== null;
  }

  /** 排空队列后销毁；后续 enqueue/retryLatest 一律拒绝。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.ensureRunning();
    await this.flush();
    const err = new Error("保存协调器已销毁");
    for (const w of this.waiters.splice(0)) w.reject(err);
  }

  private ensureRunning(): void {
    if (this.running || !this.pending) return;
    this.running = this.drain()
      .catch(() => {
        // drain 内部已逐次捕获保存异常，此处仅为兜底。
      })
      .finally(() => {
        this.running = null;
        if (!this.pending) {
          for (const resolve of this.idleWaiters.splice(0)) resolve();
        } else {
          // 排空期间来了新快照：继续串行执行。
          this.ensureRunning();
        }
      });
  }

  private async drain(): Promise<void> {
    for (;;) {
      const snapshot = this.pending;
      if (!snapshot) return;
      this.pending = null;
      this.publish({ ...this.state, status: "saving" });
      try {
        await this.runSave(snapshot);
      } catch (err) {
        // 失败保留快照供重试；若有更新快照排队，循环继续（新内容覆盖旧失败）。
        this.lastFailed = snapshot;
        this.settleWaiters(snapshot.generation, null, err);
        this.publish({ ...this.state, status: "error" });
      }
    }
  }

  private async runSave(snapshot: SaveSnapshot): Promise<void> {
    const t0 = performance.now();
    await this.deps.content.save(
      snapshot.pageId,
      snapshot.contentJson,
      snapshot.textSnapshot,
    );
    trackTiming("idb-save", performance.now() - t0);
    this.savedGeneration = snapshot.generation;
    const isLatest = snapshot.generation === this.generation;
    const now = Date.now();
    if (isLatest) {
      // 间隔自动版本：跟随成功保存的最新快照。
      await this.initPromise;
      if (shouldCreateIntervalRevision(this.lastIntervalAt, now)) {
        const created = await this.deps.revisions.add(
          snapshot.pageId,
          snapshot.contentJson,
          snapshot.textSnapshot,
          "interval",
        );
        if (created) {
          this.lastIntervalAt = now;
          await this.deps.revisions.pruneInterval(
            snapshot.pageId,
            INTERVAL_REVISION_KEEP,
          );
        }
      }
      // 只有最新快照才允许清理孤儿附件，防止旧快照误删新附件。
      await this.deps.attachments.removeOrphans(
        snapshot.pageId,
        collectAttachmentIds(snapshot.contentJson),
      );
      this.deps.recovery?.clear(snapshot.pageId, this.savedGeneration);
    }
    this.settleWaiters(snapshot.generation, { generation: snapshot.generation, savedAt: now }, null);
    // 保存成功回调（搜索索引增量更新等）；按串行队列顺序触发。
    this.deps.onSaved?.(snapshot.pageId, snapshot.textSnapshot, now);
    // 规则 4：旧代次完成不发布 saved（此时必有更新快照排队或在编辑中）。
    if (isLatest) {
      this.lastFailed = null;
      this.publish({ status: "saved", savedAt: now });
    }
  }

  /** 兑现/驳回所有代次已被覆盖的等待者。 */
  private settleWaiters(
    generation: number,
    result: SaveResult | null,
    error: unknown,
  ): void {
    const remaining: Waiter[] = [];
    for (const w of this.waiters) {
      if (w.generation <= generation) {
        if (result) w.resolve(result);
        else w.reject(error);
      } else {
        remaining.push(w);
      }
    }
    this.waiters = remaining;
  }

  private publish(next: SaveCoordinatorState): void {
    this.state = next;
    this.deps.onStateChange?.(next);
  }
}
