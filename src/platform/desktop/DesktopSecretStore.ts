/**
 * R008 Stage 1（§8.2，R8-02）：Desktop 的 SecretStore port 实现——
 * 经桌面桥（E1DesktopAPI.secret）走 Main 的 Electron safeStorage 安全
 * 存储（密文落 userData/secrets.json），替换此前的 InMemorySecretStore
 * （重启丢 key）。
 *
 * 降级语义由 Main 判定并经 getStatus 暴露（与 capabilities.nativeSecrets
 * 分离——capability 表示「接入了 native secret 体系」，本状态表示本机
 * 当前是否真有安全 backend）：session-only 时 Main 侧仅进程内存兜底、
 * 绝不落盘；Renderer 不做任何 localStorage fallback（§8.7）。
 */
import type { SecretStore } from "../../application/services/SecretStore";
import type { SecretStorageStatus } from "../../application/services/SecretStorageStatus";
import type { E1DesktopAPI } from "./desktopApi";

export class DesktopSecretStore implements SecretStore {
  constructor(private readonly api: E1DesktopAPI) {}

  get(name: string): Promise<string | null> {
    return this.api.secret.get({ name });
  }

  async set(name: string, value: string): Promise<void> {
    await this.api.secret.set({ name, value });
  }

  async remove(name: string): Promise<void> {
    await this.api.secret.remove({ name });
  }

  getStatus(): Promise<SecretStorageStatus> {
    return this.api.secret.getStatus();
  }
}
