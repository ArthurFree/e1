/**
 * 资源写编排服务（R005 阶段 5）：附件导入/删除的唯一编排入口。
 *
 * importAsset 先经 domain/attachments 统一校验（单附件 20MB、单文档
 * 总量 100MB、图片 MIME 白名单、文件名长度），校验失败抛 DomainError
 * 且不落盘；配额不足等存储错误原样透传（isQuotaExceededError 可判定）。
 * 平台无关：二进制为 Uint8Array，持久化细节由注入的 AssetStore 承担。
 */
import { validateAttachment } from "../../domain/attachments";
import type { AssetStore } from "../../domain/repositories";
import type { Attachment } from "../../domain/types";

/** 导入资源入参：字节已由调用方读出（File.arrayBuffer / 粘贴板 File 等）。 */
export interface ImportAssetInput {
  pageId: string;
  name: string;
  mimeType: string;
  /** 权威字节数（与 data.byteLength 一致；取自 File.size 等实际来源）。 */
  size: number;
  data: Uint8Array;
  /** true 时按图片 MIME 白名单校验（图片插入路径）。 */
  requireImage?: boolean;
}

export interface AssetCommandServiceDeps {
  store: AssetStore;
}

export class AssetCommandService {
  constructor(private readonly deps: AssetCommandServiceDeps) {}

  /** 校验并写入附件记录，返回元数据；校验失败抛 DomainError 不落盘。 */
  async importAsset(input: ImportAssetInput): Promise<Attachment> {
    // 单文档附件总量校验需要既有总量（R004 §6.2）。
    const existing = await this.deps.store.listByDocument(input.pageId);
    const existingTotalBytes = existing.reduce((sum, a) => sum + a.size, 0);
    validateAttachment({
      name: input.name,
      mimeType: input.mimeType,
      size: input.size,
      existingTotalBytes,
      requireImage: input.requireImage,
    });
    return this.deps.store.add({
      pageId: input.pageId,
      name: input.name,
      mimeType: input.mimeType,
      size: input.size,
      data: input.data,
    });
  }

  async removeAsset(assetId: string): Promise<void> {
    await this.deps.store.remove(assetId);
  }

  /** 孤儿清理委托给 store（含 createdBeforeOrAt 时间边界，R004 INV-03）。 */
  async removeOrphans(
    pageId: string,
    referencedIds: string[],
    options?: { createdBeforeOrAt?: number },
  ): Promise<number> {
    return this.deps.store.removeOrphans(pageId, referencedIds, options);
  }
}
