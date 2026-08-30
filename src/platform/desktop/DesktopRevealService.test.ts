/**
 * R007 阶段 5（§5.2）：DesktopRevealService 测试——
 * 页面经扫描缓存解析 vaultId + relativePath（document stable id /
 * group path: id 均可），未找到页面 → DomainError(PAGE_NOT_FOUND)；
 * 附件 assetId 原样透传 Main。
 */
import { describe, expect, it, vi } from "vitest";
import type { VaultScanResult } from "./desktopApi";
import { createMockDesktopApi } from "../../test/createMockDesktopApi";
import { DesktopRevealService } from "./DesktopRevealService";
import { DesktopVaultScanCache } from "./DesktopVaultScanCache";

const SCAN: VaultScanResult = {
  vault: { vaultId: "v1", name: "笔记" },
  entries: [
    {
      noteId: null,
      relativePath: "学习",
      kind: "group",
      title: "学习",
      parentPath: null,
      tags: [],
    },
    {
      noteId: "01JABC",
      relativePath: "学习/React.md",
      kind: "document",
      title: "React 笔记",
      parentPath: "学习",
      tags: [],
    },
  ],
};

function mockApi() {
  const note = { reveal: vi.fn(async () => {}) };
  const asset = { reveal: vi.fn(async () => {}) };
  // R009 Stage 0.3：统一工厂，覆盖 scan 与两个 reveal。
  const api = createMockDesktopApi({
    vault: { scan: vi.fn(async () => SCAN) },
    note,
    asset,
  });
  return { api, note, asset };
}

describe("DesktopRevealService", () => {
  it("revealPage：document 经 stable id 解析为 vaultId + relativePath", async () => {
    const { api, note } = mockApi();
    const scans = new DesktopVaultScanCache(api);
    await scans.scan("v1");
    const reveal = new DesktopRevealService(api, scans);
    await reveal.revealPage("01JABC");
    expect(note.reveal).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "学习/React.md",
    });
  });

  it("revealPage：group（path: id）同样可定位目录", async () => {
    const { api, note } = mockApi();
    const scans = new DesktopVaultScanCache(api);
    await scans.scan("v1");
    const reveal = new DesktopRevealService(api, scans);
    await reveal.revealPage("path:学习");
    expect(note.reveal).toHaveBeenCalledWith({
      vaultId: "v1",
      relativePath: "学习",
    });
  });

  it("revealPage：页面不在任何扫描快照 → PAGE_NOT_FOUND", async () => {
    const { api } = mockApi();
    const scans = new DesktopVaultScanCache(api);
    await scans.scan("v1");
    const reveal = new DesktopRevealService(api, scans);
    await expect(reveal.revealPage("missing")).rejects.toMatchObject({
      name: "DomainError",
      code: "PAGE_NOT_FOUND",
    });
  });

  it("revealAsset：assetId 原样透传 asset.reveal（Main 侧解码 + PathGuard）", async () => {
    const { api, asset } = mockApi();
    const reveal = new DesktopRevealService(
      api,
      new DesktopVaultScanCache(api),
    );
    await reveal.revealAsset("asset:v1:v1/assets%2Fpic.png");
    expect(asset.reveal).toHaveBeenCalledWith({
      assetId: "asset:v1:v1/assets%2Fpic.png",
    });
  });

  it("IPC 失败原样拒签（由 UI 错误条展示）", async () => {
    const { api, note } = mockApi();
    note.reveal.mockRejectedValueOnce(new Error("目标不存在"));
    const scans = new DesktopVaultScanCache(api);
    await scans.scan("v1");
    const reveal = new DesktopRevealService(api, scans);
    await expect(reveal.revealPage("01JABC")).rejects.toThrow("目标不存在");
  });
});
