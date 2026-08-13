/**
 * @file 文档会话 hook（自 MainArea 提取，行为不变）。
 *
 * 单一加载 effect 承担打开链路：openDocument（R006-C3 FR-17/18）→ 正文
 * JSON 白名单校验（R003 阶段 4）→ 恢复缓冲检查（R003 §1.4），并承载
 * 损坏面板与恢复提示的处理动作。打开结果（访问级别/兼容性/写入策略）
 * 只作为数据向外暴露，由 useDocumentCompatibility 消费。
 */

import { useCallback, useEffect, useState } from "react";
import type { DocumentContent, Page } from "../../../domain/types";
import { INITIAL_CONTENT_VERSION_TOKEN } from "../../../domain/types";
import {
  parseDocumentContent,
  sanitizeDocumentContent,
} from "../../../domain/validation/documentContent";
import type { DocumentOpenResult } from "../../../application/queries/DocumentQueryService";
import type { RecoveryRecord } from "../../../application/services/RecoveryStore";
import {
  clearCorruptedDiagnostic,
  writeCorruptedDiagnostic,
} from "../../../application/services/corruptedDiagnostics";
import { useAppServices } from "../../../state/AppServicesProvider";

/** 新建文档的初始空内容（尚无 IndexedDB 内容行时使用）。 */
function emptyContent(pageId: string, workspaceId: string): DocumentContent {
  return {
    pageId,
    workspaceId,
    contentJson: { type: "doc", content: [{ type: "paragraph" }] },
    textSnapshot: "",
    // 尚无正文记录：乐观锁起点为初始版本令牌（空串），首次保存由仓储
    // 生成首个令牌（R005 阶段 3；R004 阶段 7 乐观锁语义不变）。
    version: INITIAL_CONTENT_VERSION_TOKEN,
    updatedAt: Date.now(),
  };
}

/** 正文 JSON 校验失败的原始数据与错误说明（R003 阶段 4）。 */
export interface CorruptedContent {
  raw: unknown;
  error: string;
}

export interface DocumentSession {
  /**
   * Document Session 标识：与加载 effect 的触发条件同源（文档 + 重试计数）。
   * 打开状态与冲突标记以它为归属，会话切换即自然失效。
   */
  sessionKey: string;
  content: DocumentContent | null;
  /** 编辑器重建代次：应用恢复 / 重载 / 损坏修复时递增。 */
  contentEpoch: number;
  /** 本次打开的结果；尚未加载完成或非文档页时为 null。 */
  opened: DocumentOpenResult | null;
  recovery: RecoveryRecord | null;
  corrupted: CorruptedContent | null;
  /** 正文加载失败的原始错误对象（展示模型由 describeContentError 派生）。 */
  contentError: unknown;
  retryContentLoad(): void;
  applyRecovery(): void;
  discardRecoveryPrompt(): void;
  recoverCorrupted(): void;
  exportCorrupted(): void;
  blankCorrupted(): Promise<void>;
  /** 以给定正文替换当前内容并重建编辑器（冲突重载用）。 */
  replaceLoadedContent(next: DocumentContent): void;
}

export function useDocumentSession(page: Page | null): DocumentSession {
  const services = useAppServices();
  const [content, setContent] = useState<DocumentContent | null>(null);
  // 打开结果按会话归属存放：会话切换的同一次渲染内即失效，
  // 不会把上一篇文档的访问级别/兼容性带到新文档（FR-20 §28.2）。
  const [openedState, setOpenedState] = useState<{
    key: string;
    result: DocumentOpenResult;
  } | null>(null);
  // 未落盘编辑的恢复提示（R003 §1.4）：恢复缓冲比已落盘正文更新时出现。
  const [recovery, setRecovery] = useState<RecoveryRecord | null>(null);
  // 正文 JSON 校验失败（R003 阶段 4）：不渲染编辑器，显示损坏处理面板。
  const [corrupted, setCorrupted] = useState<CorruptedContent | null>(null);
  const [contentError, setContentError] = useState<unknown>(null);
  // 正文加载重试计数：错误块「重试」递增以重跑加载 effect。
  const [contentRetryId, setContentRetryId] = useState(0);
  // 应用恢复后递增：强制编辑器以恢复内容重建，并触发一次立即保存。
  const [contentEpoch, setContentEpoch] = useState(0);

  const pageId = page?.id ?? null;
  const pageKind = page?.kind ?? null;
  const workspaceId = page?.workspaceId ?? null;
  const sessionKey = `${pageId ?? ""}:${pageKind ?? ""}:${contentRetryId}`;
  const opened = openedState?.key === sessionKey ? openedState.result : null;

  useEffect(() => {
    // cancelled 防止竞态：快速切换页面时旧请求晚到不得覆盖新页面的内容
    let cancelled = false;
    setContent(null);
    setRecovery(null);
    setCorrupted(null);
    setContentError(null);
    if (pageId && workspaceId && pageKind === "document") {
      void services.queries.document
        // R006-C3（FR-17/18）：打开主入口——正文 + 访问级别 + 兼容性；
        // Web 由查询服务默认包装（editable / lossy:false），行为不变。
        .openDocument(pageId)
        .then(async (result) => {
          if (cancelled) return;
          // 新建文档尚无内容行：以空文档作为初始内容，首次编辑即落盘。
          const base = result?.content ?? emptyContent(pageId, workspaceId);
          // 正文 JSON 运行时校验：损坏时不进编辑器，转入损坏处理面板（R003 阶段 4）。
          const parsed = parseDocumentContent(base.contentJson);
          if (!parsed.ok) {
            writeCorruptedDiagnostic({
              pageId,
              raw: parsed.raw,
              error: parsed.error.message,
              detectedAt: Date.now(),
            });
            setCorrupted({ raw: parsed.raw, error: parsed.error.message });
            setContent(base);
            return;
          }
          // 恢复缓冲比已落盘正文更新：提示用户恢复上次未保存的编辑。
          // 只在可持久化平台检查（R006-C3 FR-22）：无持久化能力的平台
          // 不启动协调器，恢复缓冲永不写入，无需读取。
          if (services.capabilities.documentPersistence) {
            const record = await services.recoveryStore.read(pageId);
            if (cancelled) return;
            if (record && record.timestamp > base.updatedAt) {
              setRecovery(record);
            }
          }
          if (result) setOpenedState({ key: sessionKey, result });
          setContent(base);
        })
        .catch((err: unknown) => {
          // 加载失败按 DomainError.code 分流为中文错误块（§36.3），不再
          // 永远停在加载占位，也不展示原始英文 message / Node 栈。
          if (cancelled) return;
          console.error("文档内容加载失败", err);
          setContentError(err);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [pageId, pageKind, workspaceId, sessionKey, services]);

  const retryContentLoad = useCallback(() => {
    setContentRetryId((id) => id + 1);
  }, []);

  const replaceLoadedContent = useCallback((next: DocumentContent) => {
    setContent(next);
    setContentEpoch((e) => e + 1);
  }, []);

  // 应用恢复缓冲：以恢复内容重建编辑器，并由编辑器立即执行一次保存；
  // 恢复缓冲本身在保存成功后由协调器清除（期间重复提示可接受）。
  const applyRecovery = useCallback(() => {
    if (!recovery || !content) return;
    setContent({
      ...content,
      contentJson: recovery.contentJson,
      updatedAt: recovery.timestamp,
    });
    setRecovery(null);
    setContentEpoch((e) => e + 1);
  }, [recovery, content]);

  const discardRecoveryPrompt = useCallback(() => {
    if (page) void services.recoveryStore.discard(page.id);
    setRecovery(null);
  }, [page, services]);

  // 损坏正文：尝试恢复（sanitize 尽力保留合法内容），重建编辑器并立即保存。
  const recoverCorrupted = useCallback(() => {
    if (!corrupted || !content) return;
    const sanitized = sanitizeDocumentContent(corrupted.raw);
    setCorrupted(null);
    setContent({ ...content, contentJson: sanitized, updatedAt: Date.now() });
    setContentEpoch((e) => e + 1);
  }, [corrupted, content]);

  // 损坏正文：导出原始 JSON 供排查或外部修复。
  const exportCorrupted = useCallback(() => {
    if (!corrupted || !page) return;
    const blob = new Blob([JSON.stringify(corrupted.raw, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${page.title || "无标题"}.corrupted.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [corrupted, page]);

  // 损坏正文：以空白文档覆盖（原始 JSON 已保留在诊断记录中，可先导出）。
  // 经文档命令服务原子覆盖并同步搜索索引（R004 阶段 3 / R005 批次 2）。
  const blankCorrupted = useCallback(async () => {
    if (!page) return;
    await services.commands.document.replaceContent({
      pageId: page.id,
      contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      textSnapshot: "",
    });
    clearCorruptedDiagnostic(page.id);
    setCorrupted(null);
    setContent(emptyContent(page.id, page.workspaceId));
    setContentEpoch((e) => e + 1);
  }, [page, services]);

  return {
    sessionKey,
    content,
    contentEpoch,
    opened,
    recovery,
    corrupted,
    contentError,
    retryContentLoad,
    applyRecovery,
    discardRecoveryPrompt,
    recoverCorrupted,
    exportCorrupted,
    blankCorrupted,
    replaceLoadedContent,
  };
}
