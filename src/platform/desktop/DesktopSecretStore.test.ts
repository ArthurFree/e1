/**
 * R007 阶段 5（§5.1）：DesktopSecretStore——SecretStore port 的
 * IPC 透传测试（get/set/remove 一一对应 api.secret.*）。
 */
import { describe, expect, it, vi } from "vitest";
import { createMockDesktopApi } from "../../test/createMockDesktopApi";
import { DesktopSecretStore } from "./DesktopSecretStore";

function mockApi() {
  const secret = {
    status: vi.fn(async () => ({ mode: "secure-persistent" as const })),
    get: vi.fn(async (_name: string) => null as string | null),
    set: vi.fn(async (_input: { name: string; value: string }) => {}),
    remove: vi.fn(async (_name: string) => {}),
  };
  // R009 Stage 0.3：统一工厂，仅覆盖 secret 组。
  const api = createMockDesktopApi({ secret });
  return { api, secret };
}

describe("DesktopSecretStore", () => {
  it("get 透传 api.secret.get（含 null 缺失语义）", async () => {
    const { api, secret } = mockApi();
    secret.get.mockResolvedValueOnce("sk-机密");
    const store = new DesktopSecretStore(api);
    await expect(store.get("ai.apiKey")).resolves.toBe("sk-机密");
    expect(secret.get).toHaveBeenCalledWith("ai.apiKey");
    await expect(store.get("ai.apiKey")).resolves.toBeNull();
  });

  it("set / remove 透传对应 IPC", async () => {
    const { api, secret } = mockApi();
    const store = new DesktopSecretStore(api);
    await store.set("ai.apiKey", "sk-新");
    expect(secret.set).toHaveBeenCalledWith({
      name: "ai.apiKey",
      value: "sk-新",
    });
    await store.remove("ai.apiKey");
    expect(secret.remove).toHaveBeenCalledWith("ai.apiKey");
  });

  it("IPC 失败原样拒签（不做静默降级）", async () => {
    const { api, secret } = mockApi();
    secret.get.mockRejectedValueOnce(new Error("桥不可用"));
    const store = new DesktopSecretStore(api);
    await expect(store.get("ai.apiKey")).rejects.toThrow("桥不可用");
  });
});
