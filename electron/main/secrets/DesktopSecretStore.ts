/**
 * R008 Stage 1（§8.2/§8.4）：Main 侧 secret 存储编排。
 *
 * 数据流：secret.* IPC handler → 本类 → safeStorage 加解密 →
 * SecretFilePersistence（userData/secrets.json 密文落盘）。
 *
 * 三档运行模式（resolveSecretBackendStatus 判定，进程内缓存一次）：
 * - secure-persistent：safeStorage 加密 → 密文落盘，重启保持；
 * - session-only：仅进程内存 Map 兜底，绝不读写持久文件——
 *   不安全 backend 下禁止明文/弱保护落盘（§8.5/§20）；
 * - unavailable：set 抛 SECRET_STORAGE_UNAVAILABLE；get 返回 null、
 *   remove 为 no-op（删除语义保持安全）。
 *
 * 加解密优先异步接口（encryptStringAsync/decryptStringAsync，Electron 43
 * 可用），缺失时退回同步版。密文条目解密失败（文件被换机拷贝、keychain
 * 条目丢失等）视为缺失返回 null——与 SecretStore port「记录损坏返回
 * null」语义一致。任何错误消息不携带 secret 值（§15.2）。
 */
import { IpcFailure } from "../../../shared/errors.js";
import type { SecretStorageStatus } from "../../../shared/ipc/contracts.js";
import {
  resolveSecretBackendStatus,
  type ResolveSecretBackendOptions,
  type SafeStorageLike,
} from "./SecretBackendStatus.js";
import type { SecretFilePersistence } from "./SecretFilePersistence.js";

export class DesktopSecretStore {
  /** session-only 模式的进程内存兜底（重启即失，与模式语义一致）。 */
  private readonly sessionValues = new Map<string, string>();
  private statusCache: SecretStorageStatus | null = null;

  constructor(
    private readonly persistence: SecretFilePersistence,
    private readonly safeStorage: SafeStorageLike | undefined,
    private readonly options: ResolveSecretBackendOptions = {},
  ) {}

  /** 当前后端运行状态（进程内缓存：backend 选择不随会话变化）。 */
  getStatus(): SecretStorageStatus {
    if (!this.statusCache) {
      this.statusCache = resolveSecretBackendStatus(
        this.safeStorage,
        this.options,
      );
    }
    return this.statusCache;
  }

  /** 读取 secret；不存在或记录损坏（解密失败）返回 null。 */
  async get(name: string): Promise<string | null> {
    const mode = this.getStatus().mode;
    if (mode === "unavailable") return null;
    if (mode === "session-only") return this.sessionValues.get(name) ?? null;
    const ciphertext = await this.persistence.getCiphertext(name);
    if (ciphertext === null) return null;
    try {
      return await this.decrypt(Buffer.from(ciphertext, "base64"));
    } catch {
      return null;
    }
  }

  /** 写入（覆盖）secret；unavailable 抛 SECRET_STORAGE_UNAVAILABLE。 */
  async set(name: string, value: string): Promise<void> {
    const mode = this.getStatus().mode;
    if (mode === "unavailable") {
      throw new IpcFailure(
        "SECRET_STORAGE_UNAVAILABLE",
        "当前系统安全存储不可用，无法保存机密值",
      );
    }
    if (mode === "session-only") {
      this.sessionValues.set(name, value);
      return;
    }
    const encrypted = await this.encrypt(value);
    await this.persistence.put(name, encrypted.toString("base64"));
  }

  /** 删除 secret；对缺失记录为 no-op（unavailable 下同样安全 no-op）。 */
  async remove(name: string): Promise<void> {
    const mode = this.getStatus().mode;
    this.sessionValues.delete(name);
    if (mode !== "secure-persistent") return;
    await this.persistence.delete(name);
  }

  /** 加密：优先 encryptStringAsync（Electron 43+），退回同步版。 */
  private encrypt(value: string): Promise<Buffer> {
    const safe = this.safeStorage;
    if (safe && typeof safe.encryptStringAsync === "function") {
      return safe.encryptStringAsync(value);
    }
    if (safe && typeof safe.encryptString === "function") {
      return Promise.resolve(safe.encryptString(value));
    }
    return Promise.reject(
      new IpcFailure(
        "SECRET_STORAGE_UNAVAILABLE",
        "当前系统安全存储不可用，无法保存机密值",
      ),
    );
  }

  /** 解密：优先 decryptStringAsync，退回同步版；失败由调用方按缺失处理。 */
  private async decrypt(encrypted: Buffer): Promise<string> {
    const safe = this.safeStorage;
    if (safe && typeof safe.decryptStringAsync === "function") {
      // Electron 43：shouldReEncrypt（密钥轮换）时需再次调用取新解密串。
      const first = await safe.decryptStringAsync(encrypted);
      if (!first.shouldReEncrypt) return first.result;
      const second = await safe.decryptStringAsync(encrypted);
      return second.result;
    }
    if (safe && typeof safe.decryptString === "function") {
      return safe.decryptString(encrypted);
    }
    throw new Error("safeStorage 解密接口不可用");
  }
}
