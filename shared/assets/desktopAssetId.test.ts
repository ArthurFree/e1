/**
 * R006-C5：Desktop Asset ID 与 e1-asset URL。
 */
import { describe, expect, it } from "vitest";
import {
  decodeDesktopAssetId,
  e1AssetUrl,
  encodeDesktopAssetId,
  parseE1AssetUrl,
} from "./desktopAssetId.js";

describe("encode/decodeDesktopAssetId", () => {
  it("同 Vault + 同 Path 身份一致；跨 Vault 不同", () => {
    const a = encodeDesktopAssetId("v1", "assets/fiber.png");
    const b = encodeDesktopAssetId("v1", "assets/fiber.png");
    const c = encodeDesktopAssetId("v2", "assets/fiber.png");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(decodeDesktopAssetId(a)).toEqual({
      vaultId: "v1",
      relativePath: "assets/fiber.png",
    });
  });

  it("拒绝 .. 与绝对路径形态", () => {
    expect(decodeDesktopAssetId("asset:v1:v1/../etc/passwd")).toBeNull();
    expect(decodeDesktopAssetId("not-an-id")).toBeNull();
  });

  it("支持 transient vaultId（含冒号）", () => {
    const id = encodeDesktopAssetId("transient:abc", "media/a.png");
    expect(decodeDesktopAssetId(id)).toEqual({
      vaultId: "transient:abc",
      relativePath: "media/a.png",
    });
  });
});

describe("parseE1AssetUrl", () => {
  it("合法 URL 解析出 assetId", () => {
    const assetId = encodeDesktopAssetId("v1", "assets/a.png");
    const parsed = parseE1AssetUrl(e1AssetUrl(assetId));
    expect(parsed).toEqual({ ok: true, assetId });
  });

  it("拒绝绝对路径与查询串", () => {
    expect(parseE1AssetUrl("e1-asset:///Users/foo.png").ok).toBe(false);
    expect(parseE1AssetUrl("e1-asset://asset?path=/Users/foo.png").ok).toBe(
      false,
    );
  });
});
