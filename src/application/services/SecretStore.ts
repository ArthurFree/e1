/**
 * SecretStore port（R005 阶段 8 §8.2）：机密值（当前仅 AI API Key）的
 * 读写抽象，与普通偏好模型（ApplicationSettings）分离——机密不再作为
 * Preferences 记录的一部分落盘。
 *
 * 实现：
 * - Web：IndexedDB 独立 secrets object store（DB v5，
 *   src/infrastructure/secretStore.ts）；
 * - 内存：src/infrastructure/memory/secretStore.ts（随内存容器存活）；
 * - 未来 Desktop：系统安全存储（见 docs/requirements/r005.md §十三）。
 *
 * 安全约束不变：机密只存本机，不进入日志、同步、分析或错误上报；
 * secret 变更不做跨标签页广播（最小实现，见 AIConfigService 注释）。
 */

/** 命名约定 "<域>.<键>"；当前唯一的 secret：AI API Key。 */
export const AI_API_KEY_SECRET = "ai.apiKey";

export interface SecretStore {
  /** 读取 secret；不存在（或记录损坏）返回 null。 */
  get(name: string): Promise<string | null>;
  /** 写入（覆盖）secret。 */
  set(name: string, value: string): Promise<void>;
  /** 删除 secret；对缺失记录为 no-op。 */
  remove(name: string): Promise<void>;
}
