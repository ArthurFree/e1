/**
 * id.ts —— 实体主键生成。
 * 基础设施层的公共小工具：页面、知识库、标签、版本、附件等所有实体的 id 都由这里生成，
 * 统一为字符串主键，与 IndexedDB 各 store 的 keyPath 对应。
 */

/**
 * 生成全局唯一 id。
 * 优先使用加密安全的 `crypto.randomUUID()`；老环境（或 insecure context）下
 * 退化为「时间戳（base36）+ 随机串」，碰撞概率对本应用的单用户本地场景足够低。
 */
export function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
