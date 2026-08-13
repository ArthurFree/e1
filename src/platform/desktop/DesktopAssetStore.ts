/**
 * R006-C5：Desktop AssetStore——资源落 Vault/assets/，不物理删除。
 */
import { DomainError } from "../../domain/errors";
import type { AssetStore, CreateAttachmentInput } from "../../domain/repositories";
import { resolveAttachmentSource } from "../../domain/repositories";
import type { Attachment, BinaryAttachment } from "../../domain/types";
import type { E1DesktopAPI } from "./desktopApi";
import { DesktopIpcError } from "./desktopApi";
import type { DesktopAssetRegistry } from "./DesktopAssetRegistry";
import type { DesktopVaultScanCache } from "./DesktopVaultScanCache";

export class DesktopAssetStore implements AssetStore {
  constructor(
    private readonly api: E1DesktopAPI,
    private readonly scans: DesktopVaultScanCache,
    private readonly assets: DesktopAssetRegistry,
  ) {}

  async getMetadata(id: string): Promise<Attachment | undefined> {
    const record = this.assets.get(id);
    if (!record) return undefined;
    return toAttachment(record);
  }

  async getBinary(id: string): Promise<BinaryAttachment | undefined> {
    const record = this.assets.get(id);
    if (!record) return undefined;
    try {
      const result = await this.api.asset.read({ assetId: id });
      return {
        attachment: toAttachment({ ...record, size: result.sizeBytes, mimeType: result.mimeType, name: result.name }),
        data: result.data,
      };
    } catch {
      return undefined;
    }
  }

  async listByDocument(pageId: string): Promise<Attachment[]> {
    return this.assets.listByDocument(pageId).map(toAttachment);
  }

  async add(input: CreateAttachmentInput): Promise<Attachment> {
    const found = await this.scans.findDocument(input.pageId);
    if (!found) {
      throw new DomainError(
        "PAGE_NOT_FOUND",
        "这篇笔记已经不存在。它可能已经被其他程序移动或删除。",
      );
    }
    const source = resolveAttachmentSource(input);
    const ipcSource =
      source.kind === "bytes"
        ? { kind: "bytes" as const, data: source.data }
        : { kind: "pick-token" as const, token: source.ref };
    let imported;
    try {
      imported = await this.api.asset.import({
        vaultId: found.vaultId,
        fileName: input.name,
        mimeType: input.mimeType,
        source: ipcSource,
      });
    } catch (err) {
      mapAssetWriteError(err);
    }
    const attachment: Attachment = {
      id: imported.assetId,
      pageId: input.pageId,
      name: input.name,
      mimeType: imported.mimeType,
      size: imported.sizeBytes,
      createdAt: Date.now(),
    };
    this.assets.register({
      id: imported.assetId,
      vaultId: found.vaultId,
      relativePath: imported.relativePath,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      pageId: input.pageId,
    });
    return attachment;
  }

  async remove(id: string): Promise<void> {
    this.assets.removeSessionReference(id);
  }

  async removeOrphans(): Promise<number> {
    return 0;
  }
}

function toAttachment(record: {
  id: string;
  pageId: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt?: number;
}): Attachment {
  return {
    id: record.id,
    pageId: record.pageId,
    name: record.name,
    mimeType: record.mimeType,
    size: record.size,
    createdAt: record.createdAt ?? 0,
  };
}

export function mapAssetWriteError(err: unknown): never {
  if (err instanceof DesktopIpcError) {
    switch (err.code) {
      case "VAULT_READ_ONLY":
        throw new DomainError(
          "VAULT_READ_ONLY",
          "当前知识库处于仅预览模式，E1 不会修改这个文件夹中的任何内容。",
        );
      case "ASSET_WRITE_PERMISSION_DENIED":
        throw new DomainError(
          "ASSET_WRITE_PERMISSION_DENIED",
          "无法写入资源文件，当前系统用户没有该目录的写入权限。",
        );
      case "ASSET_WRITE_IO_ERROR":
        throw new DomainError(
          "ASSET_WRITE_IO_ERROR",
          "写入资源文件时发生系统错误。",
        );
      case "ASSET_SOURCE_NOT_FOUND":
        throw new DomainError(
          "ASSET_SOURCE_NOT_FOUND",
          "所选文件已经不存在，请重新选择。",
        );
      case "SELECTION_INVALID":
      case "SELECTION_EXPIRED":
        throw new DomainError("INVALID_INPUT", err.message);
      case "INVALID_INPUT":
        throw new DomainError("INVALID_INPUT", err.message, err.details);
      case "PATH_ESCAPE":
        throw new DomainError("INVALID_INPUT", err.message);
      default:
        throw err;
    }
  }
  throw err;
}
