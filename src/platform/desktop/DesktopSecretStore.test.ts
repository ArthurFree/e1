/**
 * R007 阶段 5（§5.1）：DesktopSecretStore——SecretStore port 的
 * IPC 透传测试（get/set/remove 一一对应 api.secret.*）。
 */
import { describe, expect, it, vi } from "vitest";
import type { E1DesktopAPI } from "./desktopApi";
import { DesktopSecretStore } from "./DesktopSecretStore";

function mockApi() {
  const secret = {
    status: vi.fn(async () => ({ available: true })),
    get: vi.fn(async (_name: string) => null as string | null),
    set: vi.fn(async (_input: { name: string; value: string }) => {}),
    remove: vi.fn(async (_name: string) => {}),
  };
  const api = { secret } as unknown as E1DesktopAPI;
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
