/**
 * R008 Stage 1（§8.6，R8-02）：secret 存储后端运行状态——平台无关类型。
 *
 * 与 RuntimeCapabilities.nativeSecrets 分离（R8-02）：
 * - capability = 这个 Runtime 是否接入了 native secret 体系（静态）；
 * - 本类型 = 这台机器当前是否真的有安全 secret backend（运行态）。
 *
 * Desktop 经 secret.getStatus IPC 上报（shared/ipc/contracts 的
 * SecretStorageStatus 为同形线格式，两处独立声明以保持 application 不
 * 依赖 shared）；Web/内存实现不提供状态（SecretStore.getStatus 缺省），
 * UI 回退到各端既有文案。
 */
export interface SecretStorageStatus {
  /**
   * secure-persistent：系统安全存储可用，机密安全持久化（重启保持）；
   * session-only：当前无安全 backend，机密仅本次会话有效（绝不落盘）；
   * unavailable：secret 体系完全不可用（读写拒绝）。
   */
  mode: "secure-persistent" | "session-only" | "unavailable";
  /** 安全后端标识（如 keychain / kwallet6 / basic_text）；不可得时缺省。 */
  backend?: string;
  /** 降级原因（机器可读短串）。 */
  reason?: string;
}
