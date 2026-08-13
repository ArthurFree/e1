/**
 * R006-C5：Desktop 原生文件选择 → PickedAsset.authorized-ref（ref = pickToken）。
 * Application / Editor 看不见 pickToken 这个名字，只看见 authorized-ref。
 *
 * Portable Vault 的 .e1.zip 导入需要 Renderer 侧字节（ZipReader），
 * 不能走「复制进 assets/」的 pick-token 通道；zip accept 因此分流到
 * 可选的 bytesPicker（Web `<input type=file>`，Electron renderer 可用）。
 */
import type {
  AssetPicker,
  AssetPickOptions,
  PickedAsset,
} from "../../application/assets/assetServices";
import type { E1DesktopAPI } from "./desktopApi";

export function needsBytesSource(accept?: string): boolean {
  if (!accept) return false;
  const lower = accept.toLowerCase();
  return /\.zip\b|application\/zip|application\/x-zip/.test(lower);
}

export class DesktopAssetPicker implements AssetPicker {
  constructor(
    private readonly api: E1DesktopAPI,
    private readonly bytesPicker?: AssetPicker,
  ) {}

  async pick(options?: AssetPickOptions): Promise<PickedAsset | null> {
    if (this.bytesPicker && needsBytesSource(options?.accept)) {
      return this.bytesPicker.pick(options);
    }
    const accept = options?.accept
      ? options.accept
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : undefined;
    const picked = await this.api.asset.pick(accept ? { accept } : undefined);
    if (!picked) return null;
    return {
      name: picked.name,
      mimeType: picked.mimeType,
      size: picked.sizeBytes,
      source: { kind: "authorized-ref", ref: picked.pickToken },
    };
  }
}
