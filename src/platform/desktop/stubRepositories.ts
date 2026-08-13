/**
 * R006 阶段 2（C2）+ C4-E：Desktop 桩仓储。
 *
 * C4-E：Revision / removeOrphans 改为诚实空操作，避免 SaveCoordinator
 * 维护步骤阻断正常正文保存。附件已迁至 DesktopAssetStore（C5）。
 * DocumentWriteRepository 已迁至 repositories.ts（C4-G）。
 */
import type { RevisionRepository } from "../../domain/repositories";
import type { DocumentRevision } from "../../domain/types";

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
