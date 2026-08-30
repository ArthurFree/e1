/**
 * R007 阶段 5（§5.2）：DesktopAssetAccessService.reveal——
 * 成功 true；IPC 失败（缺失/拒绝）false（节点状态文案由调用方展示）。
 */
import { describe, expect, it, vi } from "vitest";
import { createMockDesktopApi } from "../../test/createMockDesktopApi";
import { DesktopAssetAccessService } from "./DesktopAssetAccessService";
import type { DesktopAssetRegistry } from "./DesktopAssetRegistry";
import type { DesktopAssetStore } from "./DesktopAssetStore";

function mockApi(revealImpl: () => Promise<void>) {
  const reveal = vi.fn(revealImpl);
  // R009 Stage 0.3：统一工厂，仅覆盖 asset.reveal。
  const api = createMockDesktopApi({ asset: { reveal } });
  return { api, reveal };
}

// reveal 不触碰 registry/store，以最小桩构造。
const stubs = {
  assets: {} as DesktopAssetRegistry,
  store: {} as DesktopAssetStore,
};

describe("DesktopAssetAccessService.reveal（R007 阶段 5）", () => {
  it("成功：透传 assetId 并返回 true", async () => {
    const { api, reveal } = mockApi(async () => {});
    const access = new DesktopAssetAccessService(
      api,
      stubs.assets,
      stubs.store,
    );
    await expect(access.reveal("asset:v1:v/a.png")).resolves.toBe(true);
    expect(reveal).toHaveBeenCalledWith({ assetId: "asset:v1:v/a.png" });
  });

  it("IPC 失败（目标不存在/桥错误）返回 false，不抛出", async () => {
    const { api } = mockApi(async () => {
      throw new Error("REVEAL_TARGET_NOT_FOUND");
    });
    const access = new DesktopAssetAccessService(
      api,
      stubs.assets,
      stubs.store,
    );
    await expect(access.reveal("asset:v1:v/gone.png")).resolves.toBe(false);
  });
});
