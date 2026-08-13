/**
 * 保存协调器（R003 阶段 1）：单文档保存的串行队列与代次（generation）管理。
 *
 * 解决的问题：
 * - 旧实现中防抖触发、flush、重试可并发执行 doSave，乱序完成时旧内容
 *   覆盖新内容，且旧保存会把仍有未保存内容的 UI 误报为「已保存」；
 * - 旧快照的孤儿附件清理会误删新快照引用的附件。
 *
 * 核心规则（R003 §1.1 + R004 阶段 1）：
 * 1. 每次编辑 generation + 1（noteEdit）；
 * 2. 同一文档所有保存串行执行；
 * 3. 队列中只保留最新尚未执行的快照；
 * 4. 旧 generation 保存完成后不发布 saved（每个 await 之后重查 isCurrent）；
 * 5. 只有当前 generation 才执行维护任务（间隔版本/附件清理/恢复缓冲清理），
 *    附件清理只删快照 capturedAt 之前已存在的孤儿（INV-03）；
 * 6. 正文提交失败保留最新快照用于重试；维护失败不污染正文保存状态，
 *    经 onMaintenanceError 上报诊断（INV-02 与 R004 §1.5）。
 *
 * 仓储经构造函数注入（domain port），本模块不依赖 IndexedDB 具体实现。
 */
import type { AssetStore, RevisionRepository } from "../../domain/repositories";
import { isDomainError, isQuotaExceededError } from "../../domain/errors";
import {
  INITIAL_CONTENT_VERSION_TOKEN,
  type ContentVersionToken,
} from "../../domain/types";
import {
  INTERVAL_REVISION_KEEP,
  INTERVAL_REVISION_MAX_BYTES,
  shouldCreateIntervalRevision,
} from "../../domain/revisions";
import { collectAttachmentIds } from "../../editor/attachment";
import { increment, trackTiming } from "../devDiagnostics";
import type { DocumentContentCommitter } from "./DocumentCommitService";
import type { RecoveryRecord } from "./RecoveryStore";

/** 待保存快照；generation 与 capturedAt 由协调器在入队时盖章。 */
export interface SaveSnapshot {
  pageId: string;
  generation: number;
  /** 快照产生时间：附件清理只删该时间之前已存在的孤儿（R004 INV-03）。 */
  capturedAt: number;
  contentJson: unknown;
  textSnapshot: string;
}

export interface SaveResult {
  generation: number;
  savedAt: number;
}

export type SaveStatus = "saved" | "dirty" | "saving" | "error";

/**
 * 保存失败分类（R004 阶段 6/7 + R006-C4）：
 * - quota = 本地存储空间不足，需用户清理后重试；
 * - conflict = 乐观锁冲突（磁盘版本被其他标签页/外部程序推进），不自动重试，
 *   由冲突 UI 提供「重新载入 / 另存副本 / 强制覆盖 / 复制内容」；
 * - lossy = Markdown 序列化有损，自动保存暂停，需用户显式「仍然保存」；
 * - generic = 其他写入失败。
 */
export type SaveErrorKind = "quota" | "conflict" | "lossy" | "generic";

export interface SaveCoordinatorState {
  status: SaveStatus;
  savedAt: number | null;
  /** status 为 error 时的失败分类；其余状态为 null。 */
  errorKind: SaveErrorKind | null;
}

/**
 * 恢复缓冲写入点（窄接口，R005 阶段 8）：协调器只负责「入队时写、保存
 * 成功清」，读取/丢弃由 UI 经 AppServices.recoveryStore（RecoveryStore
 * port）消费。方法为同步返回类型，RecoveryStore 的异步实现可直接赋值
 * （Promise 返回被丢弃；Web/内存实现内部自行降级，不会拒绝）。
 */
export interface RecoverySink {
  write(record: RecoveryRecord): void;
  clear(pageId: string, savedGeneration: number): void;
}

export interface SaveCoordinatorDeps {
  /** 正文提交通道（R004 阶段 2）：落盘 + 搜索索引同步由提交服务单点保证。 */
  committer: DocumentContentCommitter;
  revisions: RevisionRepository;
  /**
   * 孤儿附件清理（R005 阶段 5 起收窄为 AssetStore 的 removeOrphans；
   * 装配根注入实现，维护任务只跟随当前代次快照）。
   */
  assets: Pick<AssetStore, "removeOrphans">;
  /** 可选恢复缓冲写入点；每次入队写、保存成功清。 */
  recovery?: RecoverySink;
  /**
   * 维护步骤失败回调（R004 阶段 1）：版本创建、附件清理、恢复缓冲清理
   * 失败时正文已落盘，不进 error 态，只经此回调上报诊断。
   */
  onMaintenanceError?(
    stage: "revision" | "attachment-cleanup" | "recovery-cleanup",
    error: unknown,
  ): void;
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
  /**
   * 已落盘正文版本令牌（R004 阶段 7 乐观锁；R005 阶段 3 起为不透明
   * ContentVersionToken）：初始为编辑器加载时的 content.version（经构造
   * 参数传入），每次提交成功后回填新令牌；强制覆盖时由调用方读磁盘最新
   * 版本后经 setLoadedVersion 更新。协调器不解析令牌，只原样传递。
   */
  private knownVersion: ContentVersionToken;
  private state: SaveCoordinatorState = {
    status: "saved",
    savedAt: null,
    errorKind: null,
  };
  /** 上一个 interval 版本时间的异步回填（取代原组件内的 lastIntervalAtRef）。 */
  private readonly initPromise: Promise<void>;

  constructor(
    private readonly pageId: string,
    private readonly deps: SaveCoordinatorDeps,
    options?: { initialVersion?: ContentVersionToken },
  ) {
    // 缺省为 INITIAL_CONTENT_VERSION_TOKEN（空串）：尚无正文记录的新文档，
    // 与仓储「首次保存」路径的初始版本语义对齐（R005 阶段 3）。
    this.knownVersion =
      options?.initialVersion ?? INITIAL_CONTENT_VERSION_TOKEN;
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

  /** 当前已落盘版本令牌（乐观锁 expectedVersion 来源；不透明，原样传递）。 */
  getLoadedVersion(): ContentVersionToken {
    return this.knownVersion;
  }

  /**
   * 更新已落盘版本令牌：编辑器加载/重载正文时以 content.version 初始化；
   * 冲突后「强制覆盖」先读磁盘最新版本再调本方法，随后 retryLatest
   * 即可以正确的 expectedVersion 重试当前快照（R004 阶段 7）。
   */
  setLoadedVersion(version: ContentVersionToken): void {
    this.knownVersion = version;
  }

  /** 每次编辑调用：代次 +1 并发布 dirty；旧保存此后完成不得再发布 saved。 */
  noteEdit(): void {
    this.generation += 1;
    this.publish({ ...this.state, status: "dirty", errorKind: null });
  }

  /**
   * 提交保存快照（取当前代次盖章）。队列只保留最新快照：
   * 尚未执行的旧快照被替换，其等待者随更新快照的保存完成而兑现。
   */
  enqueue(input: {
    contentJson: unknown;
    textSnapshot: string;
  }): Promise<SaveResult> {
    if (this.disposed) {
      return Promise.reject(new Error("保存协调器已销毁"));
    }
    const snapshot: SaveSnapshot = {
      pageId: this.pageId,
      generation: this.generation,
      capturedAt: Date.now(),
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
    if (!this.pending && !this.lastFailed) {
      // 空状态没有可重试的快照：显式拒绝，避免等待者永远挂起（R004 §1.6）。
      return Promise.reject(new Error("没有可重试的保存"));
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
      this.publish({ ...this.state, status: "saving", errorKind: null });
      try {
        await this.runSave(snapshot);
      } catch (err) {
        // 失败保留快照供重试；若有更新快照排队，循环继续（新内容覆盖旧失败）。
        // 区分本地存储空间不足（quota）、乐观锁冲突（conflict）与普通写入失败，
        // UI 给出不同提示（R004 阶段 6/7）；冲突不自动重试，等用户选择处理方式。
        this.lastFailed = snapshot;
        this.settleWaiters(snapshot.generation, null, err);
        this.publish({
          ...this.state,
          status: "error",
          errorKind: isDomainError(err, "DOCUMENT_CONFLICT")
            ? "conflict"
            : isDomainError(err, "MARKDOWN_LOSSY_OUTPUT")
              ? "lossy"
              : isQuotaExceededError(err)
                ? "quota"
                : "generic",
        });
      }
    }
  }

  /**
   * 最新性判定（R004 §1.2）：每次 await 之后必须重新调用，
   * 不得缓存为布尔值——后处理的每个挂起窗口内都可能产生新编辑。
   */
  private isCurrent(snapshot: SaveSnapshot): boolean {
    return !this.disposed && snapshot.generation === this.generation;
  }

  private async runSave(snapshot: SaveSnapshot): Promise<void> {
    const savedAt = await this.commitContent(snapshot);
    this.settleWaiters(
      snapshot.generation,
      { generation: snapshot.generation, savedAt },
      null,
    );
    // 旧快照：正文已按序落盘（提交服务已同步索引），维护与 saved 发布只属于当前 generation。
    if (!this.isCurrent(snapshot)) return;
    await this.runMaintenance(snapshot, savedAt);
    // 维护的挂起窗口内可能来了新编辑：发布前再查一次（INV-02）。
    if (this.isCurrent(snapshot)) {
      this.lastFailed = null;
      this.publish({ status: "saved", savedAt, errorKind: null });
    }
  }

  /** 正文提交：唯一的致命步骤——失败即 error 态并保留快照供重试。 */
  private async commitContent(snapshot: SaveSnapshot): Promise<number> {
    const t0 = performance.now();
    // 乐观锁（R004 阶段 7）：以已落盘版本令牌为 expectedVersion（不透明，
    // 原样传递，R005 阶段 3）；磁盘版本被其他标签页推进时抛
    // DOCUMENT_CONFLICT（errorKind: conflict）。
    const { savedAt, version } = await this.deps.committer.commit(
      snapshot.pageId,
      snapshot.contentJson,
      snapshot.textSnapshot,
      this.knownVersion,
    );
    trackTiming("idb-save", performance.now() - t0);
    this.knownVersion = version;
    this.savedGeneration = snapshot.generation;
    return savedAt;
  }

  /**
   * 维护任务（R004 §1.4/§1.5）：自动版本、版本裁剪、孤儿附件清理、恢复缓冲清理。
   * 每个步骤独立兜底：维护失败时正文已落盘，经 onMaintenanceError 上报诊断，
   * 不进入 error 态、不要求用户重新保存正文。步骤之间重查最新性。
   */
  private async runMaintenance(
    snapshot: SaveSnapshot,
    savedAt: number,
  ): Promise<void> {
    try {
      // 间隔自动版本：跟随成功保存的最新快照。
      await this.initPromise;
      if (shouldCreateIntervalRevision(this.lastIntervalAt, savedAt)) {
        const created = await this.deps.revisions.add(
          snapshot.pageId,
          snapshot.contentJson,
          snapshot.textSnapshot,
          "interval",
        );
        if (created) {
          this.lastIntervalAt = savedAt;
          if (this.isCurrent(snapshot)) {
            // 数量上限 + 单文档自动版本总字节预算双重裁剪（R004 阶段 6）。
            await this.deps.revisions.pruneInterval(
              snapshot.pageId,
              INTERVAL_REVISION_KEEP,
              INTERVAL_REVISION_MAX_BYTES,
            );
          }
        }
      }
    } catch (err) {
      this.deps.onMaintenanceError?.("revision", err);
    }
    if (!this.isCurrent(snapshot)) return;
    try {
      // 附件清理只删快照产生之前已存在的孤儿，防止误删窗口内新建附件（INV-03）。
      await this.deps.assets.removeOrphans(
        snapshot.pageId,
        collectAttachmentIds(snapshot.contentJson),
        { createdBeforeOrAt: snapshot.capturedAt },
      );
    } catch (err) {
      this.deps.onMaintenanceError?.("attachment-cleanup", err);
    }
    if (!this.isCurrent(snapshot)) return;
    try {
      this.deps.recovery?.clear(snapshot.pageId, this.savedGeneration);
    } catch (err) {
      this.deps.onMaintenanceError?.("recovery-cleanup", err);
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
