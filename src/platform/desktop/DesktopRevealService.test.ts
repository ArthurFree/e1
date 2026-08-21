/**
 * R008 Stage 2（§9，R8-07）：DesktopRevealService 契约测试。
 * 会话身份（pageId/assetId）→ 会话缓存反查 {vaultId, relativePath} →
 * 桥调用 note.reveal / asset.reveal；反查缺失或 IPC 失败归一 false；
 * 本层不出现 absolutePath。
 */
import { describe, expect, it, vi } from "vitest";
import type { E1DesktopAPI } from "./desktopApi";
import { DesktopAssetRegistry } from "./DesktopAssetRegistry";
import { DesktopDocumentSourceCache } from "./DesktopDocumentSourceCache";
import type { DesktopDocumentSourceContext } from "./DesktopDocumentSourceCache";
import { DesktopRevealService } from "./DesktopRevealService";

function makeApi() {
  return {
    note: { reveal: vi.fn(async () => null) },
    asset: { reveal: vi.fn(async () => null) },
  } as unknown as E1DesktopAPI & {
    note: { reveal: ReturnType<typeof vi.fn> };
    asset: { reveal: ReturnType<typeof vi.fn> };
  };
}

function sourceContext(
  pageId: string,
  relativePath: string,
): DesktopDocumentSourceContext {
  return {
    vaultId: "v-1",
    sessionPageId: pageId,
    relativePath,
    stableNoteId: "n-1",
    metadata: { id: "n-1", title: "笔记" },
    frontmatterExtra: [],
    lineEnding: "lf",
    hadUtf8Bom: false,
    versionToken: "sha256:x",
    compatibility: { lossy: false, unsupported: [] },
    writeSession: {
      sourceLossyApproved: false,
      outputLossyApproved: false,
      identityAdoptionApproved: false,
    },
  };
}

describe("DesktopRevealService.revealDocument", () => {
  it("有来源上下文 → 以 {vaultId, relativePath} 调 note.reveal，返回 true", async () => {
    const api = makeApi();
    const sources = new DesktopDocumentSourceCache();
    sources.set("page-1", sourceContext("page-1", "学习/笔记.md"));
    const service = new DesktopRevealService(
      api,
      sources,
      new DesktopAssetRegistry(),
    );

    await expect(service.revealDocument("page-1")).resolves.toBe(true);
    expect(api.note.reveal).toHaveBeenCalledWith({
      vaultId: "v-1",
      relativePath: "学习/笔记.md",
    });
    expect(api.asset.reveal).not.toHaveBeenCalled();
  });

  it("无来源上下文 → false，不发起 IPC", async () => {
    const api = makeApi();
    const service = new DesktopRevealService(
      api,
      new DesktopDocumentSourceCache(),
      new DesktopAssetRegistry(),
    );

    await expect(service.revealDocument("page-未知")).resolves.toBe(false);
    expect(api.note.reveal).not.toHaveBeenCalled();
  });

  it("IPC 失败（文件已移动/删除等）→ 归一 false", async () => {
    const api = makeApi();
    api.note.reveal.mockRejectedValue(new Error("NOTE_NOT_FOUND"));
    const sources = new DesktopDocumentSourceCache();
    sources.set("page-1", sourceContext("page-1", "笔记.md"));
    const service = new DesktopRevealService(
      api,
      sources,
      new DesktopAssetRegistry(),
    );

    await expect(service.revealDocument("page-1")).resolves.toBe(false);
  });
});

describe("DesktopRevealService.revealAsset", () => {
  it("已注册附件 → 以 {vaultId, relativePath} 调 asset.reveal，返回 true", async () => {
    const api = makeApi();
    const assets = new DesktopAssetRegistry();
    assets.register({
      id: "asset-1",
      vaultId: "v-1",
      relativePath: "assets/design.pdf",
      name: "design.pdf",
      mimeType: "application/pdf",
      size: 128,
      pageId: "page-1",
    });
    const service = new DesktopRevealService(
      api,
      new DesktopDocumentSourceCache(),
      assets,
    );

    await expect(service.revealAsset("asset-1")).resolves.toBe(true);
    expect(api.asset.reveal).toHaveBeenCalledWith({
      vaultId: "v-1",
      relativePath: "assets/design.pdf",
    });
    expect(api.note.reveal).not.toHaveBeenCalled();
  });

  it("未注册附件 → false，不发起 IPC", async () => {
    const api = makeApi();
    const service = new DesktopRevealService(
      api,
      new DesktopDocumentSourceCache(),
      new DesktopAssetRegistry(),
    );

    await expect(service.revealAsset("asset-未知")).resolves.toBe(false);
    expect(api.asset.reveal).not.toHaveBeenCalled();
  });

  it("IPC 失败 → 归一 false", async () => {
    const api = makeApi();
    api.asset.reveal.mockRejectedValue(new Error("ASSET_NOT_FOUND"));
    const assets = new DesktopAssetRegistry();
    assets.register({
      id: "asset-1",
      vaultId: "v-1",
      relativePath: "assets/a.png",
      name: "a.png",
      mimeType: "image/png",
      size: 1,
      pageId: "page-1",
    });
    const service = new DesktopRevealService(
      api,
      new DesktopDocumentSourceCache(),
      assets,
    );

    await expect(service.revealAsset("asset-1")).resolves.toBe(false);
  });
});
