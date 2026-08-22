/**
 * R006-C5：Desktop 资源访问——显示走 e1-asset://，字节走 asset.read。
 * releaseUrl 为安全 no-op（协议 URL 不占用 Object URL）。
 * R007 阶段 5：reveal 接 asset.reveal IPC（shell.showItemInFolder）。
 */
import type { AssetAccessService } from "../../application/assets/assetServices";
import type { Attachment, BinaryAttachment } from "../../domain/types";
import { e1AssetUrl } from "../../../shared/assets/desktopAssetId";
import type { E1DesktopAPI } from "./desktopApi";
import type { DesktopAssetRegistry } from "./DesktopAssetRegistry";
import type { DesktopAssetStore } from "./DesktopAssetStore";

export class DesktopAssetAccessService implements AssetAccessService {
  constructor(
    private readonly api: E1DesktopAPI,
    private readonly assets: DesktopAssetRegistry,
    private readonly store: DesktopAssetStore,
  ) {}

  getMetadata(assetId: string): Promise<Attachment | undefined> {
    return this.store.getMetadata(assetId);
  }

  getBinary(assetId: string): Promise<BinaryAttachment | undefined> {
    return this.store.getBinary(assetId);
  }

  listByDocument(pageId: string): Promise<Attachment[]> {
    return this.store.listByDocument(pageId);
  }

  async resolveUrl(assetId: string): Promise<string | null> {
    if (!this.assets.get(assetId)) {
      try {
        return await this.api.asset.resolveUrl(assetId);
      } catch {
        return null;
      }
    }
    return e1AssetUrl(assetId);
  }

  releaseUrl(): void {
    // 协议 URL 无需释放。
  }

  async download(assetId: string): Promise<boolean> {
    const binary = await this.store.getBinary(assetId);
    if (!binary || binary.data.byteLength === 0) return false;
    if (typeof URL.createObjectURL !== "function") return false;
    const url = URL.createObjectURL(
      new Blob([toArrayBuffer(binary.data)], {
        type: binary.attachment.mimeType,
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = binary.attachment.name;
    anchor.click();
    URL.revokeObjectURL(url);
    return true;
  }

  /** R007 阶段 5：在系统文件管理器中显示附件；失败（缺失/拒绝）返回 false。 */
  async reveal(assetId: string): Promise<boolean> {
    try {
      await this.api.asset.reveal({ assetId });
      return true;
    } catch {
      return false;
    }
  }
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
}
