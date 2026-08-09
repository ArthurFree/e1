/**
 * StorageHealthService 的内存实现（R005 阶段 8 §8.4）：estimate 默认
 * 降级 null（无 StorageManager 语义）；连接生命周期事件由测试经
 * emitConnectionEvent 手工注入，验证订阅转发。
 */
import type {
  StorageConnectionEvent,
  StorageEstimateInfo,
  StorageHealthCallback,
  StorageHealthService,
} from "../../application/services/StorageHealthService";

export class InMemoryStorageHealthService implements StorageHealthService {
  private readonly listeners = new Set<StorageHealthCallback>();

  constructor(
    private readonly estimateResult: StorageEstimateInfo | null = null,
  ) {}

  async estimate(): Promise<StorageEstimateInfo | null> {
    return this.estimateResult;
  }

  /** 测试注入连接事件（对应 Web 实现中装配根对 db.ts 回调的接线）。 */
  emitConnectionEvent(event: StorageConnectionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 单个订阅者异常不影响其余订阅者。
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
