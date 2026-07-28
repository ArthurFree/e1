/**
 * 本地存储配额服务（R004 阶段 6，§6.3）：
 * estimate 读取浏览器存储估算（navigator.storage.estimate），
 * API 不存在或返回异常值时降级为 null。
 * 配额错误判定 isQuotaExceededError 在 domain/errors.ts
 * （editor 层也需要，放 domain 避免 editor → application 反向依赖）。
 *
 * 无状态、无依赖，直接导出模块级函数；UI（设置面板）使用。
 */

/** 存储用量估算；usageRatio = usage / quota（0～1）。 */
export interface StorageEstimateInfo {
  usage: number;
  quota: number;
  usageRatio: number;
}

/** 用量占比达到该阈值时设置页显示警告（R004 §6.3）。 */
export const STORAGE_WARN_RATIO = 0.8;

/** 读取浏览器存储估算；不支持 Storage API 时返回 null（降级，不报错）。 */
export async function estimateStorage(): Promise<StorageEstimateInfo | null> {
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
