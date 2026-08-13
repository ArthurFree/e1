/**
 * R006 阶段 2（C2）+ C4-E：Desktop 桩仓储。
 *
 * C4-E：Revision / removeOrphans 改为诚实空操作，避免 SaveCoordinator
 * 维护步骤阻断正常正文保存；附件 add/remove 仍 NOT_IMPLEMENTED（C5）。
 * DocumentWriteRepository 已迁至 repositories.ts（C4-G）。
 */
import { DomainError } from "../../domain/errors";
import type { AssetStore, RevisionRepository } from "../../domain/repositories";
import type {
  Attachment,
  BinaryAttachment,
  DocumentRevision,
} from "../../domain/types";

function notImplemented(feature: string, stage: string): DomainError {
  return new DomainError(
    "NOT_IMPLEMENTED",
    `桌面端暂不支持${feature}（将在 R006 ${stage}支持）。`,
  );
}

/**
 * 版本历史：列表恒空；add/prune 空操作（R006-C4 §51）——
 * 不产生版本，也不因维护失败阻断保存。
 */
export class DesktopRevisionRepository implements RevisionRepository {
  async listByPage(): Promise<DocumentRevision[]> {
    return [];
  }

  async add(): Promise<DocumentRevision | null> {
    return null;
  }

  async pruneInterval(): Promise<void> {
    // no-op
  }
}

/**
 * 附件资源存储：读取恒空；removeOrphans 返回 0（§52）；
 * add/remove 仍 NOT_IMPLEMENTED（C5）。
 */
export class DesktopAssetStore implements AssetStore {
  async getMetadata(): Promise<Attachment | undefined> {
    return undefined;
  }

  async getBinary(): Promise<BinaryAttachment | undefined> {
    return undefined;
  }

  async listByDocument(): Promise<Attachment[]> {
    return [];
  }

  async add(): Promise<Attachment> {
    throw notImplemented("导入附件", "阶段 5");
  }

  async remove(): Promise<void> {
    throw notImplemented("删除附件", "阶段 5");
  }

  async removeOrphans(): Promise<number> {
    return 0;
  }
}
