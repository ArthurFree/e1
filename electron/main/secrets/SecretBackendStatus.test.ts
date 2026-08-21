// @vitest-environment node
/**
 * R008 Stage 1（§8.5/§8.6）：safeStorage 后端状态判定测试。
 * 三档模式 + forceBackend 注入点 + 加解密 API 缺失降级。
 */
import { describe, expect, it, vi } from "vitest";
import {
  resolveSecretBackendStatus,
  type SafeStorageLike,
} from "./SecretBackendStatus.js";

function secureSafeStorage(
  overrides: Partial<SafeStorageLike> = {},
): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptStringAsync: vi.fn(async (v: string) => Buffer.from(`enc:${v}`)),
    decryptStringAsync: vi.fn(async (b: Buffer) => ({
      shouldReEncrypt: false,
      result: b.toString().replace(/^enc:/, ""),
    })),
    ...overrides,
  };
}

describe("resolveSecretBackendStatus", () => {
  it("safeStorage 缺失 → unavailable", () => {
    expect(resolveSecretBackendStatus(undefined)).toEqual({
      mode: "unavailable",
      reason: "safe-storage-missing",
    });
  });

  it("isEncryptionAvailable false → session-only（encryption-unavailable）", () => {
    const status = resolveSecretBackendStatus(
      secureSafeStorage({ isEncryptionAvailable: () => false }),
    );
    expect(status).toMatchObject({
      mode: "session-only",
      reason: "encryption-unavailable",
    });
  });

  it("isEncryptionAvailable 抛错 → session-only（按不可用处理）", () => {
    const status = resolveSecretBackendStatus(
      secureSafeStorage({
        isEncryptionAvailable: () => {
          throw new Error("boom");
        },
      }),
    );
    expect(status.mode).toBe("session-only");
    expect(status.reason).toBe("encryption-unavailable");
  });

  it("backend 为 basic_text → session-only（insecure-backend），即使加密可用", () => {
    const status = resolveSecretBackendStatus(
      secureSafeStorage({ getSelectedStorageBackend: () => "basic_text" }),
    );
    expect(status).toEqual({
      mode: "session-only",
      reason: "insecure-backend",
      backend: "basic_text",
    });
  });

  it("forceBackend 注入点：强制 basic_text → session-only（G11 模拟）", () => {
    const status = resolveSecretBackendStatus(
      secureSafeStorage({ getSelectedStorageBackend: () => "kwallet6" }),
      { forceBackend: "basic_text" },
    );
    expect(status).toEqual({
      mode: "session-only",
      reason: "insecure-backend",
      backend: "basic_text",
    });
  });

  it("安全 backend + 加密可用 → secure-persistent，携带 backend 标识", () => {
    const status = resolveSecretBackendStatus(
      secureSafeStorage({ getSelectedStorageBackend: () => "kwallet6" }),
    );
    expect(status).toEqual({ mode: "secure-persistent", backend: "kwallet6" });
  });

  it("getSelectedStorageBackend 抛错 → 忽略 backend 字段，不影响判定", () => {
    const status = resolveSecretBackendStatus(
      secureSafeStorage({
        getSelectedStorageBackend: () => {
          throw new Error("not-linux");
        },
      }),
    );
    expect(status).toEqual({ mode: "secure-persistent" });
  });

  it("加解密 API 全缺 → unavailable（safe-storage-api-missing）", () => {
    const status = resolveSecretBackendStatus({
      isEncryptionAvailable: () => true,
    });
    expect(status).toEqual({
      mode: "unavailable",
      reason: "safe-storage-api-missing",
    });
  });

  it("仅同步 API 也可用 → secure-persistent", () => {
    const status = resolveSecretBackendStatus({
      isEncryptionAvailable: () => true,
      encryptString: (v: string) => Buffer.from(`enc:${v}`),
      decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ""),
    });
    expect(status).toEqual({ mode: "secure-persistent" });
  });
});
