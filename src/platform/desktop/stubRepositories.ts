/**
 * R006 阶段 2（C2）：Desktop 桩仓储——本批不涉及的 port 的最小实现。
 *
 * 读方法返回空集（版本列表/附件元数据在 UI 上呈现为「无」），
 * 写方法一律抛 DomainError("NOT_IMPLEMENTED") 诚实失败。
 * 这些实现随对应阶段替换：版本历史随阶段 4（note.save 后才有版本来源）、
 * 附件随阶段 5（vault assets/）、原子文档写随阶段 3（note.create/save）。
 */
import { DomainError } from "../../domain/errors";
import type {
  AssetStore,
  DocumentWriteRepository,
  RevisionRepository,
} from "../../domain/repositories";
import type {
  Attachment,
  BinaryAttachment,
  DocumentRevision,
  Page,
} from "../../domain/types";

function notImplemented(feature: string, stage: string): DomainError {
  return new DomainError(
    "NOT_IMPLEMENTED",
    `桌面端暂不支持${feature}（将在 R006 ${stage}支持）。`,
  );
}

/** 版本历史桩：列表恒空；写入抛错（阶段 4 前桌面端不产生版本）。 */
export class DesktopRevisionRepository implements RevisionRepository {
  async listByPage(): Promise<DocumentRevision[]> {
    return [];
  }

  async add(): Promise<DocumentRevision | null> {
    throw notImplemented("创建版本历史", "阶段 4");
  }

  async pruneInterval(): Promise<void> {
    throw notImplemented("清理版本历史", "阶段 4");
  }
}

/** 附件资源存储桩：读取恒空；写入抛错（附件落 vault assets/ 属阶段 5）。 */
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
    throw notImplemented("清理孤儿附件", "阶段 5");
  }
}

/** 原子文档写桩：模板/AI/导入等统一写入路径在桌面端抛错（阶段 3）。 */
export class DesktopDocumentWriteRepository implements DocumentWriteRepository {
  async createWithContent(): Promise<Page> {
    throw notImplemented("创建文档", "阶段 3（note.create）");
  }

  async replaceContent(): Promise<never> {
    throw notImplemented("覆盖文档内容", "阶段 4（note.save）");
  }
}
