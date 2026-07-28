/**
 * 存储连接事件总线（R004 阶段 7 §7.1）：IndexedDB 连接生命周期事件
 * 从 infrastructure（db.ts）到 UI 的通道。
 *
 * db.ts 不 import UI：装配根（browserServices）创建本总线实例，
 * 经 setStorageConnectionEvents 把 db.ts 的 blocked/versionchange/terminated
 * 回调转发为总线事件；UI（AppShell 提示条）经 AppServices 容器订阅。
 * 事件语义：
 * - blocked：本标签页发起的数据库升级被其他标签页阻塞——提示关闭其他标签页；
 * - versionchange：其他标签页完成了数据库升级，本连接已关闭——提示刷新页面；
 * - terminated：连接异常终止（缓存已清空，下次操作自动重连）——可观测用。
 */
export type StorageConnectionEvent = "blocked" | "versionchange" | "terminated";

export type StorageConnectionListener = (event: StorageConnectionEvent) => void;

/** 极简 pub/sub：同步分发，订阅返回退订函数。 */
export class StorageConnectionEventBus {
  private readonly listeners = new Set<StorageConnectionListener>();

  emit(event: StorageConnectionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 单个订阅者异常不影响其余订阅者与存储主流程。
      }
    }
  }

  subscribe(listener: StorageConnectionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
