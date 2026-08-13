import { describe, expect, it, vi } from "vitest";
import type {
  AssetPicker,
  PickedAsset,
} from "../../application/assets/assetServices";
import type { E1DesktopAPI } from "./desktopApi";
import { DesktopAssetPicker, needsBytesSource } from "./DesktopAssetPicker";

function zipPicked(): PickedAsset {
  return {
    name: "vault.e1.zip",
    mimeType: "application/zip",
    size: 4,
    source: { kind: "bytes", data: new Uint8Array([1, 2, 3, 4]) },
  };
}

describe("DesktopAssetPicker", () => {
  it("needsBytesSource：zip accept 走字节通道", () => {
    expect(needsBytesSource(".zip,application/zip")).toBe(true);
    expect(needsBytesSource("image/png")).toBe(false);
    expect(needsBytesSource(undefined)).toBe(false);
  });

  it("图片 accept 走原生 pickToken，不读字节", async () => {
    const api = {
      asset: {
        pick: vi.fn(async () => ({
          pickToken: "tok-1",
          name: "a.png",
          sizeBytes: 3,
          mimeType: "image/png",
        })),
      },
    } as unknown as E1DesktopAPI;
    const bytes: AssetPicker = { pick: vi.fn(async () => zipPicked()) };
    const picker = new DesktopAssetPicker(api, bytes);
    const picked = await picker.pick({
      accept: "image/png,image/jpeg",
    });
    expect(picked?.source).toEqual({ kind: "authorized-ref", ref: "tok-1" });
    expect(api.asset.pick).toHaveBeenCalledOnce();
    expect(bytes.pick).not.toHaveBeenCalled();
    expect(JSON.stringify(picked)).not.toContain("absolutePath");
  });

  it("zip accept 走 bytesPicker，不签发 pickToken", async () => {
    const api = {
      asset: { pick: vi.fn() },
    } as unknown as E1DesktopAPI;
    const bytes: AssetPicker = { pick: vi.fn(async () => zipPicked()) };
    const picker = new DesktopAssetPicker(api, bytes);
    const picked = await picker.pick({ accept: ".zip,application/zip" });
    expect(picked?.source.kind).toBe("bytes");
    expect(api.asset.pick).not.toHaveBeenCalled();
  });
});
