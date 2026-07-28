/**
 * 文档恢复缓冲（R003 §1.4）：编辑器未落盘内容的最后一道兜底。
 *
 * beforeunload 无法保证 IndexedDB 异步写入完成，因此每次有编辑进入保存
 * 队列时，把最新正文快照同步写入 localStorage；保存成功后清除。
 * 应用加载文档时若发现恢复缓冲比 IndexedDB 中的正文更新，提示用户恢复。
 *
 * 安全约定：只写正文 JSON 与元数据，不写附件 Blob，不写任何密钥；
 * localStorage 与 IndexedDB 同属本地数据源，不扩大数据暴露面。
 */
import { parseDocumentContent } from "../../domain/validation/documentContent";

/** 恢复缓冲记录：正文 JSON + 保存代次 + 写入时间。 */
export interface DocumentRecoveryRecord {
  pageId: string;
  contentJson: unknown;
  generation: number;
  timestamp: number;
}

const KEY_PREFIX = "pending-document-recovery:";

function keyOf(pageId: string): string {
  return `${KEY_PREFIX}${pageId}`;
}

/** 写入/覆盖某文档的恢复缓冲；localStorage 不可用或超限时仅告警，不阻塞编辑。 */
export function writeRecovery(record: DocumentRecoveryRecord): void {
  try {
    localStorage.setItem(keyOf(record.pageId), JSON.stringify(record));
  } catch (err) {
    // 恢复缓冲是兜底机制，失败只降级不致命（如隐私模式禁用 localStorage）。
    console.warn("恢复缓冲写入失败", err);
  }
}

/**
 * 保存成功后清除恢复缓冲。
 * 仅当缓冲内容的代次已被落盘（≤ savedGeneration）时才删除，
 * 避免旧保存清掉更新的未落盘内容。
 */
export function clearRecovery(pageId: string, savedGeneration: number): void {
  try {
    const raw = localStorage.getItem(keyOf(pageId));
    if (!raw) return;
    const record = JSON.parse(raw) as DocumentRecoveryRecord;
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

/** 无条件丢弃某文档的恢复缓冲（用户选择「丢弃」时）。 */
export function discardRecovery(pageId: string): void {
  try {
    localStorage.removeItem(keyOf(pageId));
  } catch (err) {
    console.warn("恢复缓冲丢弃失败", err);
  }
}

/** 读取恢复缓冲；数据损坏（含正文 JSON 未通过白名单校验）时删除并返回 null。 */
export function readRecovery(pageId: string): DocumentRecoveryRecord | null {
  try {
    const raw = localStorage.getItem(keyOf(pageId));
    if (!raw) return null;
    const record = JSON.parse(raw) as DocumentRecoveryRecord;
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
