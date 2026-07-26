/**
 * 损坏正文诊断记录（R003 阶段 4）：正文校验失败时把原始数据留在本地，
 * 供「尝试恢复 / 导出原始 JSON / 创建空白副本」之外的排查兜底。
 *
 * 当前存放在 localStorage（R003 阶段 7 数据库升级时再迁入 IndexedDB 诊断
 * store）；写入失败（超限/隐私模式）仅告警，不阻断恢复流程。
 * 安全约定：与 IndexedDB 正文同属本地数据源，不扩大暴露面。
 */

import { increment } from "../devDiagnostics";

/** 一条损坏诊断记录。 */
export interface CorruptedDocumentDiagnostic {
  pageId: string;
  /** 未通过校验的原始 contentJson。 */
  raw: unknown;
  /** 校验失败原因（DomainError message）。 */
  error: string;
  detectedAt: number;
}

const KEY_PREFIX = "diagnostic:corrupted-document:";

function keyOf(pageId: string): string {
  return `${KEY_PREFIX}${pageId}`;
}

/** 写入/覆盖某文档的损坏诊断记录；失败仅告警。 */
export function writeCorruptedDiagnostic(
  record: CorruptedDocumentDiagnostic,
): void {
  // 开发诊断：损坏事件计数（仅 pageId，R003 §8.3）。
  increment("corrupted-content", record.pageId);
  try {
    localStorage.setItem(keyOf(record.pageId), JSON.stringify(record));
  } catch (err) {
    console.warn("损坏诊断记录写入失败", err);
  }
}

/** 读取诊断记录（测试与排查用）；解析失败按无记录处理。 */
export function readCorruptedDiagnostic(
  pageId: string,
): CorruptedDocumentDiagnostic | null {
  try {
    const raw = localStorage.getItem(keyOf(pageId));
    if (!raw) return null;
    return JSON.parse(raw) as CorruptedDocumentDiagnostic;
  } catch {
    return null;
  }
}

/** 正文恢复合法后清除诊断记录。 */
export function clearCorruptedDiagnostic(pageId: string): void {
  try {
    localStorage.removeItem(keyOf(pageId));
  } catch (err) {
    console.warn("损坏诊断记录清理失败", err);
  }
}
