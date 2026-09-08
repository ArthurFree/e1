/**
 * @file 本地版本历史面板（R001 §8.3）：文档编辑区右侧的版本列表。
 * 每条版本显示时间、产生原因（自动 / 恢复前 / 手动）、大小与正文摘要，
 * 点击展开全文快照预览；恢复采用二次确认，且恢复前先把当前内容
 * 另存为「恢复前」版本，保证恢复操作本身也可回退。
 *
 * R012 Stage 0（summary + lazy get）：列表只渲染 RevisionSummary
 * （时间/原因/大小/textPreview），展开预览时才经 getRevision 取回完整
 * DocumentRevision。Stage 4（需求 §23 Safe Restore）：恢复改走
 * controller.restoreRevision（RevisionRestoreCoordinator：before-restore
 * 快照 + 平台 port——Web=JSON 提交，Desktop=Main raw body 合并落盘）。
 * Stage 5（需求 §27/§28）：面板头部「创建版本」（flush →
 * createManualRevision，去重命中提示「内容与当前版本一致」）与预览块
 * 「与当前版本比较」（diffWithCurrent 取数 + RevisionDiff 行级渲染）。
 * UI 不判断平台（DUAL-01），只消费 AppServices 与 operations 矩阵。
 */

import { useCallback, useEffect, useState } from "react";
import type {
  DocumentRevision,
  RevisionReason,
  RevisionSummary,
} from "../domain/types";
import { DomainError } from "../domain/errors";
import type { DocumentEditorController } from "../application/services/DocumentEditorController";
import { useAppServices } from "../state/AppServicesProvider";
import { formatBytes } from "../editor/attachment";
import { Dialog } from "./ui/Dialog";
import { EmptyState } from "./ui/EmptyState";
import { RevisionDiff } from "./RevisionDiff";

interface VersionPanelProps {
  /** 所属文档 ID，按它列出全部历史版本。 */
  pageId: string;
  /** 当前文档的编辑器控制器：恢复版本经它与保存协调器串行化（R004 阶段 3）。 */
  controller: DocumentEditorController;
  /** 关闭面板（恢复成功后自动关闭）。 */
  onClose(): void;
}

/** 版本产生原因的展示文案。 */
const REASON_LABEL: Record<RevisionReason, string> = {
  interval: "自动",
  "before-restore": "恢复前",
  manual: "手动",
};

/**
 * 本地版本历史（R001 §8.3）：列表显示时间、原因和正文摘要；
 * 恢复前先把当前内容存为「恢复前」版本，再写回选中版本。
 */
export function VersionPanel({
  pageId,
  controller,
  onClose,
}: VersionPanelProps) {
  const services = useAppServices();
  const [revisions, setRevisions] = useState<RevisionSummary[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  // 展开预览的完整版本（lazy get）：undefined = 加载中；null = 记录缺失。
  const [preview, setPreview] = useState<DocumentRevision | null | undefined>(
    undefined,
  );
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // 面板级错误（恢复 / 创建版本），按 DomainError.message 呈现。
  const [error, setError] = useState<string | null>(null);
  // 非错误提示（如创建版本去重命中）。
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // 「与当前版本比较」：diffId = 正在比较的版本；diff 三态同 preview。
  const [diffId, setDiffId] = useState<string | null>(null);
  const [diff, setDiff] = useState<
    { historical: string; current: string } | null | undefined
  >(undefined);

  const reload = useCallback(async () => {
    setRevisions(await services.queries.document.listRevisions(pageId));
  }, [pageId, services]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 展开预览时按需取回完整版本（lazy get）；切换/收起时丢弃。
  useEffect(() => {
    if (previewId === null) {
      setPreview(undefined);
      return;
    }
    let cancelled = false;
    setPreview(undefined);
    void services.queries.document
      .getRevision(pageId, previewId)
      .then((revision) => {
        if (!cancelled) setPreview(revision ?? null);
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pageId, previewId, services]);

  // 取「历史版本 vs 当前正文」对比数据（diffWithCurrent 内部已 lazy get 目标）。
  useEffect(() => {
    if (diffId === null || !services.revisionRestore) {
      setDiff(undefined);
      return;
    }
    let cancelled = false;
    setDiff(undefined);
    void services.revisionRestore
      .diffWithCurrent({
        pageId,
        revisionId: diffId,
        currentTextSnapshot: controller.getSnapshot().textSnapshot,
      })
      .then((result) => {
        if (!cancelled) setDiff(result);
      })
      .catch(() => {
        if (!cancelled) setDiff(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pageId, diffId, services, controller]);

  /**
   * 创建版本（R012 Stage 5 §28）：先 flush 挂起保存（失败/冲突不创建，
   * 错误原样呈现），再按当前编辑器快照捕获 manual 版本；
   * 与最新版本内容一致时 createManualRevision 返回 null（去重命中）。
   */
  const createRevision = async () => {
    setError(null);
    setNotice(null);
    setCreating(true);
    try {
      await controller.flush();
      const snapshot = controller.getSnapshot();
      const created = await services.commands.document.createManualRevision(
        pageId,
        snapshot.contentJson,
        snapshot.textSnapshot,
      );
      if (created === null) {
        setNotice("内容与当前版本一致，未创建新版本。");
      } else {
        await reload();
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "创建版本失败，请稍后重试。",
      );
    } finally {
      setCreating(false);
    }
  };

  const restore = async (revisionId: string) => {
    setError(null);
    // R012 Stage 4（需求 §23）：恢复改走 RevisionRestoreCoordinator——
    // before-restore 快照 + 平台 port（Web=JSON 串行提交，Desktop=Main
    // raw body 合并落盘）；UI 不判断平台，按 DomainError.code 呈现文案。
    try {
      await controller.restoreRevision(revisionId);
    } catch (err) {
      setError(
        err instanceof DomainError ? err.message : "恢复失败，请稍后重试。",
      );
      setConfirmId(null);
      return;
    }
    setConfirmId(null);
    onClose();
  };

  // 创建版本入口：operations 门控 + revisionRestore 存在性兜底（DUAL-01）。
  const canCreate =
    services.operations.revision.write && services.revisionRestore != null;
  // 「与当前版本比较」取数走 revisionRestore.diffWithCurrent。
  const canDiff = services.revisionRestore != null;

  return (
    <Dialog label="版本历史" className="version-panel" onClose={onClose}>
      <div className="dialog__header">
        <span>版本历史</span>
        {canCreate && (
          <button
            type="button"
            className="version-panel__create"
            disabled={creating}
            onClick={() => void createRevision()}
          >
            {creating ? "创建中…" : "创建版本"}
          </button>
        )}
      </div>
      {error && (
        <p className="version-panel__error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="version-panel__notice">{notice}</p>}
      {revisions.length === 0 ? (
        <EmptyState title="暂无历史版本" hint="编辑保存后自动记录。" />
      ) : (
        <div className="version-panel__list">
          {revisions.map((revision) => (
            <div key={revision.id} className="version-panel__item">
              <button
                type="button"
                className="version-panel__summary"
                aria-expanded={previewId === revision.id}
                onClick={() => {
                  setPreviewId(previewId === revision.id ? null : revision.id);
                  setConfirmId(null);
                  setDiffId(null);
                }}
              >
                <span className="version-panel__time">
                  {new Date(revision.createdAt).toLocaleString("zh-CN")}
                </span>
                <span className="version-panel__reason">
                  {REASON_LABEL[revision.reason]}
                </span>
                <span className="version-panel__size">
                  {formatBytes(revision.bytes)}
                </span>
                <span className="version-panel__snippet">
                  {revision.textPreview.slice(0, 40) || "（空文档）"}
                </span>
              </button>
              {previewId === revision.id && (
                <div className="version-panel__preview">
                  {preview === undefined ? (
                    <div className="version-panel__text">加载中…</div>
                  ) : preview === null ? (
                    <div className="version-panel__text">
                      该版本已不存在或无法读取。
                    </div>
                  ) : (
                    <>
                      {diffId === revision.id ? (
                        diff === undefined ? (
                          <div className="version-panel__text">加载中…</div>
                        ) : diff === null ? (
                          <div className="version-panel__text">
                            该版本已不存在或无法读取。
                          </div>
                        ) : (
                          <RevisionDiff
                            before={diff.historical}
                            after={diff.current}
                          />
                        )
                      ) : (
                        <div className="version-panel__text">
                          {preview.textSnapshot || "（空文档）"}
                        </div>
                      )}
                      <div className="version-panel__actions">
                        {canDiff && (
                          <button
                            type="button"
                            className="version-panel__compare"
                            aria-pressed={diffId === revision.id}
                            onClick={() =>
                              setDiffId(
                                diffId === revision.id ? null : revision.id,
                              )
                            }
                          >
                            {diffId === revision.id
                              ? "查看版本内容"
                              : "与当前版本比较"}
                          </button>
                        )}
                        <button
                          type="button"
                          className={`version-panel__restore${confirmId === revision.id ? " version-panel__restore--danger" : ""}`}
                          onClick={() => {
                            if (confirmId === revision.id) {
                              void restore(revision.id);
                            } else {
                              setConfirmId(revision.id);
                            }
                          }}
                        >
                          {confirmId === revision.id
                            ? "确认恢复？"
                            : "恢复此版本"}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
