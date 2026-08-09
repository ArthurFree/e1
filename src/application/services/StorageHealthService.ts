/**
 * StorageHealthService port（R005 阶段 8 §8.4）：存储健康能力的统一抽象，
 * 合并原 StorageQuotaService（存储用量估算）与 StorageConnectionEventBus
 * （IndexedDB 连接生命周期事件）两能力。
 *
 * 实现：
 * - Web：platform/web/webStorageHealth.ts（navigator.storage.estimate +
 *   db.ts 连接回调经装配根接线到 emitConnectionEvent）；
 * - 内存：infrastructure/memory/storageHealth.ts（estimate 降级 null，
 *   事件可手工注入）；
 * - 未来 Desktop：磁盘剩余空间 / SQLite 状态 / Vault 可写状态
 *   （见 docs/requirements/r005.md §十三）。
 *
 * 配额错误判定 isQuotaExceededError 仍在 domain/errors.ts，不随本 port 移动。
 */

/** 存储用量估算；usageRatio = usage / quota（0～1）。 */
export interface StorageEstimateInfo {
  usage: number;
  quota: number;
  usageRatio: number;
}

/** 用量占比达到该阈值时设置页显示警告（R004 §6.3）。 */
export const STORAGE_WARN_RATIO = 0.8;

/**
 * 存储连接生命周期事件（R004 阶段 7 §7.1）：
 * - blocked：本标签页发起的数据库升级被其他标签页阻塞——提示关闭其他标签页；
 * - versionchange：其他标签页完成了数据库升级，本连接已关闭——提示刷新页面；
 * - terminated：连接异常终止（缓存已清空，下次操作自动重连）——可观测用。
 */
export type StorageConnectionEvent = "blocked" | "versionchange" | "terminated";

export type StorageHealthCallback = (event: StorageConnectionEvent) => void;

export interface StorageHealthService {
  /** 读取存储用量估算；不支持或估算失败时返回 null（降级，不报错）。 */
  estimate(): Promise<StorageEstimateInfo | null>;
  /** 订阅连接生命周期事件；返回退订函数。 */
  subscribe(callback: StorageHealthCallback): () => void;
}
