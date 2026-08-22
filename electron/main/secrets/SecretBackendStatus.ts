/**
 * R008 Stage 1（§8.5/§8.6，R8-02）：安全存储后端状态评估。
 *
 * 判定口径：
 * - 非 Linux（macOS Keychain / Windows DPAPI）：isEncryptionAvailable()
 *   即安全后端 → secure-persistent；
 * - Linux：getSelectedStorageBackend() 为 gnome_libsecret/kwallet* 才
 *   → secure-persistent；basic_text/unknown（无系统密钥链或
 *   --password-store=basic 弱保护）→ session-only，绝不弱保护落盘；
 * - isEncryptionAvailable() === false 或评估抛错 →
 *   session-only / unavailable（同样只允许会话内存）。
 */
import type { SecretStorageStatus } from "../../../shared/ipc/contracts.js";
import type { SafeStorageLike } from "./SecretFilePersistence.js";

/** Linux 上被视为安全的密码管理后端（basic_text/unknown 为不安全）。 */
const SECURE_LINUX_BACKENDS = new Set([
  "gnome_libsecret",
  "kwallet",
  "kwallet5",
  "kwallet6",
]);

export function evaluateSecretBackendStatus(
  safeStorage: SafeStorageLike,
  platform: NodeJS.Platform = process.platform,
): SecretStorageStatus {
  let available: boolean;
  try {
    available = safeStorage.isEncryptionAvailable();
  } catch {
    return { mode: "unavailable", reason: "系统安全存储评估失败" };
  }
  if (platform === "linux") {
    let backend: string;
    try {
      backend = safeStorage.getSelectedStorageBackend?.() ?? "unknown";
    } catch {
      backend = "unknown";
    }
    if (!available) {
      return { mode: "session-only", backend, reason: "系统安全存储不可用" };
    }
    if (!SECURE_LINUX_BACKENDS.has(backend)) {
      return {
        mode: "session-only",
        backend,
        reason: "系统安全存储后端不安全",
      };
    }
    return { mode: "secure-persistent", backend };
  }
  if (!available) {
    return { mode: "session-only", reason: "系统安全存储不可用" };
  }
  return {
    mode: "secure-persistent",
    backend: platform === "darwin" ? "keychain" : "dpapi",
  };
}
