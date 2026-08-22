/**
 * R007 阶段 5（§5.1，G3）：Desktop SecretStore——SecretStore port 的
 * IPC-backed 实现，替代 R006 起的内存 PoC（重启丢失）。
 *
 * 持久化与加密全部在 Main（safeStorage → userData/secrets.json）；
 * 系统安全存储不可用时 Main 降级为会话内存（secret.status 报告，
 * 装配根据此置 capabilities.nativeSecrets=false），本类无感知——
 * 读写语义不变，只是重启后丢失，由设置页提示用户。
 */
import type { SecretStore } from "../../application/services/SecretStore";
import type { E1DesktopAPI } from "./desktopApi";

export class DesktopSecretStore implements SecretStore {
  constructor(private readonly api: E1DesktopAPI) {}

  get(name: string): Promise<string | null> {
    return this.api.secret.get(name);
  }

  async set(name: string, value: string): Promise<void> {
    await this.api.secret.set({ name, value });
  }

  async remove(name: string): Promise<void> {
    await this.api.secret.remove(name);
  }
}
