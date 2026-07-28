/**
 * 偏好写入服务（R003 阶段 3）：串行合并所有偏好更新，杜绝读-改-写竞态。
 *
 * - 所有 update 进入同一条串行队列，后一个 patch 基于前一次写入结果合并；
 * - 侧栏宽度：250ms 防抖持久化（拖动期间由调用方实时更新内存镜像）；
 * - 路由：last-write-wins，连续导航只在队尾保留最新一次写入，
 *   保证「最后一次导航最终落盘」且旧导航不覆盖新导航；
 * - 所有写入错误统一经 onError 上报（可观测），队列不中断、
 *   不产生未处理的 Promise rejection。
 *
 * 仓储经构造函数注入（domain port），本模块不依赖 IndexedDB 具体实现。
 */
import type { PreferencesRepository } from "../../domain/repositories";
import type { Preferences } from "../../domain/types";

export interface PreferencesServiceDeps {
  preferences: PreferencesRepository;
  onError?(error: unknown): void;
  /**
   * 非路由偏好落盘成功回调（R004 §7.2）：主题/侧栏宽度/AI 配置写入后触发，
   * 装配层据此广播 preferences-changed；路由（persistRoute）不触发。
   */
  onPersisted?(): void;
}

/** 侧栏宽度持久化的防抖窗口（R003 §3.2：200～300ms）。 */
export const SIDEBAR_WIDTH_DEBOUNCE_MS = 250;

type PreferencesPatch = Partial<Omit<Preferences, "id">>;

export class PreferencesService {
  /** 串行写入链：任何时刻最多一个仓储 update 在途。 */
  private chain: Promise<void> = Promise.resolve();
  private sidebarTimer: ReturnType<typeof setTimeout> | null = null;
  private latestSidebarWidth: number | null = null;
  /** 待写入的最新路由；连续导航只保留最后一次。 */
  private pendingRoute: string | null = null;
  private routeScheduled = false;
  /** dispose 后防抖/路由等 fire-and-forget 入口变为 no-op。 */
  private disposed = false;

  constructor(private readonly deps: PreferencesServiceDeps) {}

  /**
   * 排队执行一次偏好更新，返回该次更新合并后的完整偏好。
   * 失败时错误经 onError 上报并向上抛出（调用方可感知），队列继续。
   */
  update(patch: PreferencesPatch): Promise<Preferences> {
    const run = this.enqueue(() => this.deps.preferences.update(patch));
    // 落盘成功后通知装配层广播（R004 §7.2）；失败不广播。
    void run.then(
      () => this.deps.onPersisted?.(),
      () => {},
    );
    return run;
  }

  /** 侧栏宽度：拖动期间高频调用，只在停顿后持久化最后一次。 */
  updateSidebarWidthDebounced(width: number): void {
    if (this.disposed) return;
    this.latestSidebarWidth = width;
    if (this.sidebarTimer) clearTimeout(this.sidebarTimer);
    this.sidebarTimer = setTimeout(() => {
      this.sidebarTimer = null;
      const pending = this.latestSidebarWidth;
      this.latestSidebarWidth = null;
      if (pending === null) return;
      // 错误经 onError 上报；防抖路径无人消费返回值，必须吞掉 rejection。
      void this.enqueue(() =>
        this.deps.preferences.update({ sidebarWidth: pending }),
      ).then(
        () => this.deps.onPersisted?.(),
        () => {
          // 已上报，避免未处理的 Promise rejection。
        },
      );
    }, SIDEBAR_WIDTH_DEBOUNCE_MS);
  }

  /**
   * 持久化路由（last-write-wins）：连续导航合并为队尾一次写入，
   * 写入执行时取最新的 pendingRoute，旧导航不会覆盖新导航。
   */
  persistRoute(lastRoute: string): void {
    if (this.disposed) return;
    this.pendingRoute = lastRoute;
    if (this.routeScheduled) return;
    this.routeScheduled = true;
    void this.enqueue(async () => {
      this.routeScheduled = false;
      const route = this.pendingRoute;
      this.pendingRoute = null;
      if (route === null) return;
      await this.deps.preferences.update({ lastRoute: route });
    }).catch(() => {
      // 已上报，避免未处理的 Promise rejection。
    });
  }

  /**
   * 挂载/重挂载时恢复写入（R004 阶段 4 修正）：React StrictMode 会执行
   * 「挂载 → 清理 → 再挂载」，清理阶段的 dispose 会让同一实例（useMemo
   * 不重建）整会话 no-op；Provider 在 effect 挂载时调用本方法恢复。
   */
  resume(): void {
    this.disposed = false;
  }

  /**
   * 卸载清理（R004 阶段 4）：清除侧栏防抖定时器（挂起的宽度立即补写
   * 入队，避免丢失最后一次拖动），之后的防抖/路由调用变为 no-op；
   * 返回的 Promise 在写入队列排空后兑现。
   */
  dispose(): Promise<void> {
    this.disposed = true;
    if (this.sidebarTimer) {
      clearTimeout(this.sidebarTimer);
      this.sidebarTimer = null;
      const pending = this.latestSidebarWidth;
      this.latestSidebarWidth = null;
      if (pending !== null) {
        // 错误经 onError 上报；与防抖路径一致吞掉 rejection。
        void this.enqueue(() =>
          this.deps.preferences.update({ sidebarWidth: pending }),
        ).catch(() => {
          // 已上报，避免未处理的 Promise rejection。
        });
      }
    }
    return this.chain;
  }

  /** 把任务挂到串行链尾；失败经 onError 上报但不断链。 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task);
    this.chain = run.then(
      () => undefined,
      (err: unknown) => {
        this.deps.onError?.(err);
      },
    );
    return run;
  }
}
