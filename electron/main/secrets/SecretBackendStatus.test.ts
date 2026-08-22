// @vitest-environment node
/**
 * R008 Stage 1（§8.5/§8.6）：SecretBackendStatus 评估测试——
 * 非 Linux 看 isEncryptionAvailable；Linux 必须看密码管理后端，
 * basic_text/unknown 为不安全（session-only，不弱保护落盘）。
 */
import { describe, expect, it } from "vitest";
import { evaluateSecretBackendStatus } from "./SecretBackendStatus.js";
import type { SafeStorageLike } from "./SecretFilePersistence.js";

function fakeSafeStorage(options: {
  available?: boolean;
  backend?: string;
  throwOnEvaluate?: boolean;
}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => {
      if (options.throwOnEvaluate) throw new Error("no safeStorage");
      return options.available ?? true;
    },
    encryptString: (plain) => Buffer.from(`enc:${plain}`, "utf8"),
    decryptString: (encrypted) => encrypted.toString("utf8").slice(4),
    getSelectedStorageBackend: () => options.backend ?? "unknown",
  };
}

describe("evaluateSecretBackendStatus", () => {
  it("macOS：Keychain 可用 → secure-persistent（backend=keychain）", () => {
    expect(evaluateSecretBackendStatus(fakeSafeStorage({}), "darwin")).toEqual({
      mode: "secure-persistent",
      backend: "keychain",
    });
  });

  it("Windows：可用 → secure-persistent（backend=dpapi）", () => {
    expect(evaluateSecretBackendStatus(fakeSafeStorage({}), "win32")).toEqual({
      mode: "secure-persistent",
      backend: "dpapi",
    });
  });

  it("非 Linux：不可用 → session-only", () => {
    expect(
      evaluateSecretBackendStatus(
        fakeSafeStorage({ available: false }),
        "darwin",
      ).mode,
    ).toBe("session-only");
  });

  it("Linux：gnome_libsecret / kwallet6 → secure-persistent", () => {
    for (const backend of [
      "gnome_libsecret",
      "kwallet",
      "kwallet5",
      "kwallet6",
    ]) {
      expect(
        evaluateSecretBackendStatus(fakeSafeStorage({ backend }), "linux"),
      ).toEqual({ mode: "secure-persistent", backend });
    }
  });

  it("Linux：basic_text / unknown → session-only（不安全后端，不弱保护落盘）", () => {
    for (const backend of ["basic_text", "unknown"]) {
      const status = evaluateSecretBackendStatus(
        fakeSafeStorage({ backend }),
        "linux",
      );
      expect(status.mode).toBe("session-only");
      expect(status.backend).toBe(backend);
    }
  });

  it("Linux：加密不可用 → session-only（带后端标识）", () => {
    const status = evaluateSecretBackendStatus(
      fakeSafeStorage({ available: false, backend: "basic_text" }),
      "linux",
    );
    expect(status).toMatchObject({
      mode: "session-only",
      backend: "basic_text",
    });
  });

  it("评估抛错 → unavailable", () => {
    expect(
      evaluateSecretBackendStatus(
        fakeSafeStorage({ throwOnEvaluate: true }),
        "darwin",
      ).mode,
    ).toBe("unavailable");
  });
});
