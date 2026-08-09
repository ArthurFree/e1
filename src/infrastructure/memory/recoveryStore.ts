/**
 * RecoveryStore 的内存实现（R005 阶段 8 §8.1）：Map 版恢复缓冲，
 * 供内存服务容器（测试/可替换性证明）使用，数据随容器存活。
 *
 * 与 Web 实现（platform/web/webRecoveryStore）遵守同一契约
 * （src/test/recoveryStoreContract.ts）：read 同样执行白名单校验，
 * 损坏记录删除并返回 null；clear 仅删除代次已落盘（≤ savedGeneration）
 * 的缓冲。内存实现无 IO 降级路径，写入不会失败。
 */
import { parseDocumentContent } from "../../domain/validation/documentContent";
import type {
  RecoveryRecord,
  RecoveryStore,
} from "../../application/services/RecoveryStore";

export class InMemoryRecoveryStore implements RecoveryStore {
  private readonly records = new Map<string, RecoveryRecord>();

  async write(record: RecoveryRecord): Promise<void> {
    this.records.set(record.pageId, record);
  }

  async read(pageId: string): Promise<RecoveryRecord | null> {
    const record = this.records.get(pageId);
    if (!record) return null;
    // 与 Web 实现同语义：损坏记录（含正文 JSON 未通过白名单校验）删除并返回 null。
    if (
      record.pageId !== pageId ||
      typeof record.generation !== "number" ||
      typeof record.timestamp !== "number" ||
      !("contentJson" in record) ||
      !parseDocumentContent(record.contentJson).ok
    ) {
      this.records.delete(pageId);
      return null;
    }
    return record;
  }

  async clear(pageId: string, savedGeneration: number): Promise<void> {
    const record = this.records.get(pageId);
    if (record && record.generation <= savedGeneration) {
      this.records.delete(pageId);
    }
  }

  async discard(pageId: string): Promise<void> {
    this.records.delete(pageId);
  }
}
