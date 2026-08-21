/**
 * R008 Stage 1（§8.5/§8.6，R8-02）：safeStorage 后端运行状态判定。
 *
 * 与 RuntimeCapabilities.nativeSecrets（Desktop 接入了 native secret 体系）
 * 分离——capability 静态为 true，本模块判定的是「这台机器当前是否真的有
 * 安全 secret backend」：
 *
 * - safeStorage 缺失或加解密 API 全缺 → unavailable（读写拒绝）；
 * - isEncryptionAvailable() 为 false，或 backend 为已知不安全值
 *   （Linux basic_text）→ session-only（仅进程内存兜底，绝不落盘）；
 * - 其余 → secure-persistent（密文落 userData/secrets.json）。
 *
 * forceBackend 为测试/E2E 注入点（env E1_SECRET_BACKEND_FORCE）：模拟
 * 不安全 backend 以覆盖 G11（backend 不安全 → 重启后 key 不存在）——
 * 本机/CI 无法轻易制造真实 basic_text 环境。
 */
import type { SecretStorageStatus } from "../../../shared/ipc/contracts.js";

/** Electron safeStorage 的最小结构视图（生产传真实模块，测试传 mock）。 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  /** Linux 才有真实意义；其他平台可能缺省或抛错，调用方需容忍。 */
  getSelectedStorageBackend?(): string;
  encryptString?(plainText: string): Buffer;
  decryptString?(encrypted: Buffer): string;
  /** Electron 43 起可用的异步变体（优先于同步版）。 */
  encryptStringAsync?(plainText: string): Promise<Buffer>;
  /**
   * 异步解密：Electron 43 返回 { shouldReEncrypt, result }——
   * shouldReEncrypt 为 true（密钥轮换/安全级别提升）时需再次调用取新值。
   */
  decryptStringAsync?(
    encrypted: Buffer,
  ): Promise<{ shouldReEncrypt: boolean; result: string }>;
}

export interface ResolveSecretBackendOptions {
  /** 测试注入：强制按该 backend 判定（如 "basic_text" 模拟不安全后端）。 */
  forceBackend?: string;
}

/** 已知不安全 backend：命中即 session-only，禁止明文/弱保护落盘。 */
const INSECURE_BACKENDS = new Set(["basic_text"]);

export function resolveSecretBackendStatus(
  safeStorage: SafeStorageLike | undefined,
  options: ResolveSecretBackendOptions = {},
): SecretStorageStatus {
  if (!safeStorage) {
    return { mode: "unavailable", reason: "safe-storage-missing" };
  }
  let backend: string | undefined = options.forceBackend;
  if (
    backend === undefined &&
    typeof safeStorage.getSelectedStorageBackend === "function"
  ) {
    try {
      backend = safeStorage.getSelectedStorageBackend();
    } catch {
      backend = undefined;
    }
  }
  const withBackend = (status: SecretStorageStatus): SecretStorageStatus =>
    backend !== undefined && backend !== "" ? { ...status, backend } : status;
  if (backend !== undefined && INSECURE_BACKENDS.has(backend)) {
    return withBackend({ mode: "session-only", reason: "insecure-backend" });
  }
  let encryptionAvailable: boolean;
  try {
    encryptionAvailable = safeStorage.isEncryptionAvailable();
  } catch {
    encryptionAvailable = false;
  }
  if (!encryptionAvailable) {
    return withBackend({
      mode: "session-only",
      reason: "encryption-unavailable",
    });
  }
  const canEncrypt =
    typeof safeStorage.encryptStringAsync === "function" ||
    typeof safeStorage.encryptString === "function";
  const canDecrypt =
    typeof safeStorage.decryptStringAsync === "function" ||
    typeof safeStorage.decryptString === "function";
  if (!canEncrypt || !canDecrypt) {
    return withBackend({
      mode: "unavailable",
      reason: "safe-storage-api-missing",
    });
  }
  return withBackend({ mode: "secure-persistent" });
}
