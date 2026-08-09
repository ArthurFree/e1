/**
 * StorageHealthService 的 Web 实现（R005 阶段 8 §8.4）：
 * - estimate：navigator.storage.estimate（逻辑自 application/services/
 *   StorageQuotaService.ts 原样迁入，模块已删除；StorageManager 从此
 *   只出现在 platform/web 边界）；
 * - subscribe：IndexedDB 连接生命周期事件分发——db.ts 回调由装配根
 *   （browserServices）经 setStorageConnectionCallbacks 接线到
 *   emitConnectionEvent（infrastructure 不 import platform/web）。
 */
import type {
  StorageConnectionEvent,
  StorageEstimateInfo,
  StorageHealthCallback,
  StorageHealthService,
} from "../../application/services/StorageHealthService";

export class WebStorageHealthService implements StorageHealthService {
  private readonly listeners = new Set<StorageHealthCallback>();

  /** 读取浏览器存储估算；不支持 Storage API 或估算失败时返回 null（降级，不报错）。 */
  async estimate(): Promise<StorageEstimateInfo | null> {
    if (
      typeof navigator === "undefined" ||
      !navigator.storage ||
      typeof navigator.storage.estimate !== "function"
    ) {
      return null;
    }
    try {
      const { usage, quota } = await navigator.storage.estimate();
      if (
        typeof usage !== "number" ||
        typeof quota !== "number" ||
        quota <= 0 ||
        usage < 0
      ) {
        return null;
      }
      return { usage, quota, usageRatio: usage / quota };
    } catch {
      // estimate 本身失败（罕见）：按不支持降级，不影响设置页其余功能。
      return null;
    }
  }

  /** 连接生命周期事件入口：装配根把 db.ts 回调接线到本方法。 */
  emitConnectionEvent(event: StorageConnectionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 单个订阅者异常不影响其余订阅者与存储主流程。
      }
    }
  }

  subscribe(callback: StorageHealthCallback): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }
}
