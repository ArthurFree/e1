/**
 * SecretStore port（R005 阶段 8 §8.2）：机密值（当前仅 AI API Key）的
 * 读写抽象，与普通偏好模型（ApplicationSettings）分离——机密不再作为
 * Preferences 记录的一部分落盘。
 *
 * 实现：
 * - Web：IndexedDB 独立 secrets object store（DB v5，
 *   src/platform/web/persistence/secretStore.ts）；
 * - 内存：src/infrastructure/memory/secretStore.ts（随内存容器存活）；
 * - Desktop：系统安全存储（src/platform/desktop/DesktopSecretStore.ts，
 *   R008 Stage 1——经 IPC 走 Main 的 Electron safeStorage，密文落
 *   userData/secrets.json；不安全 backend 降级 session-only 不落盘）。
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
  /**
   * R008 Stage 1（R8-02）：可选——当前 secret 存储后端的运行状态。
   * 接入 native secret 体系的实现（Desktop）提供；Web/内存实现不提供，
   * UI 对缺省实现回退到既有说明文案（类型见 ./SecretStorageStatus）。
   */
  getStatus?(): Promise<import("./SecretStorageStatus").SecretStorageStatus>;
}
