/**
 * SecretStore 的内存实现（R005 阶段 8 §8.2）：随内存容器存活，
 * 与 IndexedDB 实现共用契约套件（src/test/secretStoreContract.ts）。
 */
import type { SecretStore } from "../../application/services/SecretStore";

export class InMemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  async get(name: string): Promise<string | null> {
    return this.values.get(name) ?? null;
  }

  async set(name: string, value: string): Promise<void> {
    this.values.set(name, value);
  }

  async remove(name: string): Promise<void> {
    this.values.delete(name);
  }
}
