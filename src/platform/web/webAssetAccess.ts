/**
 * Web 资源访问实现（R005 阶段 5）：Blob 只存在于本适配边界——
 * 从 AssetStore 读出平台无关的 Uint8Array 后在此重建 Blob，
 * 用于创建 Object URL（resolveUrl/releaseUrl）与触发下载（download）。
 * Desktop 未来以自定义协议（如 e1-asset://）替换本实现，编辑器不感知。
 */
import type { AssetAccessService } from "../../application/assets/assetServices";
import type { AssetStore } from "../../domain/repositories";
import type { Attachment, BinaryAttachment } from "../../domain/types";

export class WebAssetAccessService implements AssetAccessService {
  constructor(private readonly store: AssetStore) {}

  getMetadata(assetId: string): Promise<Attachment | undefined> {
    return this.store.getMetadata(assetId);
  }

  getBinary(assetId: string): Promise<BinaryAttachment | undefined> {
    return this.store.getBinary(assetId);
  }

  listByDocument(pageId: string): Promise<Attachment[]> {
    return this.store.listByDocument(pageId);
  }

  /** 字节 → 临时 Object URL；资源缺失/为空/环境不支持时返回 null。 */
  async resolveUrl(assetId: string): Promise<string | null> {
    if (typeof URL.createObjectURL !== "function") return null;
    const binary = await this.store.getBinary(assetId).catch(() => undefined);
    if (!binary || binary.data.byteLength === 0) return null;
    return URL.createObjectURL(
      new Blob([toArrayBuffer(binary.data)], {
        type: binary.attachment.mimeType,
      }),
    );
  }

  releaseUrl(url: string): void {
    if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
  }

  /** a[download] 触发浏览器下载；资源缺失或为空时返回 false。 */
  async download(assetId: string): Promise<boolean> {
    const binary = await this.store.getBinary(assetId).catch(() => undefined);
    if (!binary || binary.data.byteLength === 0) return false;
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
}

/** Uint8Array → ArrayBuffer（按视口切片，避免共享缓冲带出多余字节）。 */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
}
