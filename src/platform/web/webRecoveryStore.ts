/**
 * RecoveryStore 的 Web 实现（R005 阶段 8 §8.1）：localStorage 恢复缓冲。
 *
 * 读写/校验/降级逻辑自 application/services/documentRecovery.ts 原样迁入
 * （模块函数已删除）；key 前缀与记录数据结构不变——用户浏览器中尚未
 * 落盘的存量恢复缓冲在本实现下照常读出，平滑衔接。
 *
 * 降级约定：localStorage 不可用或超限（如隐私模式）时仅 console.warn，
 * 不阻塞编辑主流程；读取到损坏数据（含正文 JSON 未通过白名单校验）时
 * 删除并返回 null，兑现「绝不让坏数据进入编辑器」。
 */
import { parseDocumentContent } from "../../domain/validation/documentContent";
import type {
  RecoveryRecord,
  RecoveryStore,
} from "../../application/services/RecoveryStore";

/** 恢复缓冲 key 前缀：与 R003 起的存量数据一致，不得更改。 */
const KEY_PREFIX = "pending-document-recovery:";

function keyOf(pageId: string): string {
  return `${KEY_PREFIX}${pageId}`;
}

export class WebRecoveryStore implements RecoveryStore {
  async write(record: RecoveryRecord): Promise<void> {
    try {
      localStorage.setItem(keyOf(record.pageId), JSON.stringify(record));
    } catch (err) {
      // 恢复缓冲是兜底机制，失败只降级不致命（如隐私模式禁用 localStorage）。
      console.warn("恢复缓冲写入失败", err);
    }
  }

  async read(pageId: string): Promise<RecoveryRecord | null> {
    try {
      const raw = localStorage.getItem(keyOf(pageId));
      if (!raw) return null;
      const record = JSON.parse(raw) as RecoveryRecord;
      if (
        !record ||
        record.pageId !== pageId ||
        typeof record.generation !== "number" ||
        typeof record.timestamp !== "number" ||
        !("contentJson" in record) ||
        // 正文 JSON 必须能通过运行时校验，兑现「绝不让坏数据进入编辑器」。
        !parseDocumentContent(record.contentJson).ok
      ) {
        localStorage.removeItem(keyOf(pageId));
        return null;
      }
      return record;
    } catch {
      // 解析失败按损坏处理：清除坏数据，避免每次启动重复报错。
      try {
        localStorage.removeItem(keyOf(pageId));
      } catch {
        // 忽略：清除失败不影响主流程。
      }
      return null;
    }
  }

  async clear(pageId: string, savedGeneration: number): Promise<void> {
    try {
      const raw = localStorage.getItem(keyOf(pageId));
      if (!raw) return;
      const record = JSON.parse(raw) as RecoveryRecord;
      if (
        typeof record.generation === "number" &&
        record.generation > savedGeneration
      ) {
        return;
      }
      localStorage.removeItem(keyOf(pageId));
    } catch (err) {
      console.warn("恢复缓冲清理失败", err);
    }
  }

  async discard(pageId: string): Promise<void> {
    try {
      localStorage.removeItem(keyOf(pageId));
    } catch (err) {
      console.warn("恢复缓冲丢弃失败", err);
    }
  }
}
