/**
 * R008 Stage 1（§8.2）：Renderer DesktopSecretStore 测试。
 * - 与 Web/内存实现共用 SecretStore 契约套件（mock 桥内存后端）；
 * - getStatus 透传桥返回的后端运行状态（R8-02）。
 */
import { describe, expect, it, vi } from "vitest";
import type { E1DesktopAPI } from "./desktopApi";
import type { SecretStorageStatus } from "../../application/services/SecretStorageStatus";
import { describeSecretStoreContract } from "../../test/secretStoreContract";
import { DesktopSecretStore } from "./DesktopSecretStore";

/** 内存后端的 mock 桥：secret 组四方法 + 固定 status。 */
function mockApi(status: SecretStorageStatus = { mode: "secure-persistent" }) {
  const values = new Map<string, string>();
  const api = {
    secret: {
      get: vi.fn(
        async ({ name }: { name: string }) => values.get(name) ?? null,
      ),
      set: vi.fn(async ({ name, value }: { name: string; value: string }) => {
        values.set(name, value);
        return null;
      }),
      remove: vi.fn(async ({ name }: { name: string }) => {
        values.delete(name);
        return null;
      }),
      getStatus: vi.fn(async () => status),
    },
  } as unknown as E1DesktopAPI;
  return { api, values };
}

describeSecretStoreContract("Desktop（IPC 桥 mock）", () => {
  const { api } = mockApi();
  return new DesktopSecretStore(api);
});

describe("DesktopSecretStore（桥映射）", () => {
  it("get/set/remove 按 {name}/{name,value} 形状调用桥", async () => {
    const { api } = mockApi();
    const store = new DesktopSecretStore(api);
    await store.set("ai.apiKey", "sk-1");
    expect(api.secret.set).toHaveBeenCalledWith({
      name: "ai.apiKey",
      value: "sk-1",
    });
    await store.get("ai.apiKey");
    expect(api.secret.get).toHaveBeenCalledWith({ name: "ai.apiKey" });
    await store.remove("ai.apiKey");
    expect(api.secret.remove).toHaveBeenCalledWith({ name: "ai.apiKey" });
  });

  it("getStatus 透传后端运行状态（session-only 降级如实上报）", async () => {
    const status: SecretStorageStatus = {
      mode: "session-only",
      reason: "insecure-backend",
      backend: "basic_text",
    };
    const { api } = mockApi(status);
    const store = new DesktopSecretStore(api);
    await expect(store.getStatus?.()).resolves.toEqual(status);
  });
});
