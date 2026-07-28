/**
 * @file 本地版本历史面板（R001 §8.3）：文档编辑区右侧的版本列表。
 * 每条版本显示时间、产生原因（自动 / 恢复前 / 手动）与正文摘要，
 * 点击展开全文快照预览；恢复采用二次确认，且恢复前先把当前内容
 * 另存为「恢复前」版本，保证恢复操作本身也可回退。
 */

import { useCallback, useEffect, useState } from "react";
import type { DocumentRevision, RevisionReason } from "../domain/types";
import { parseDocumentContent } from "../domain/validation/documentContent";
import type { DocumentEditorController } from "../application/services/DocumentEditorController";
import { useAppServices } from "../state/AppServicesProvider";
import { Dialog } from "./ui/Dialog";
import { EmptyState } from "./ui/EmptyState";

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
  const [revisions, setRevisions] = useState<DocumentRevision[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // 损坏版本的恢复拦截提示（R003 阶段 4：损坏内容不进入编辑器）。
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setRevisions(await services.revision.listByPage(pageId));
  }, [pageId, services]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const restore = async (revision: DocumentRevision) => {
    // 版本内容先过运行时校验：损坏版本不进入编辑器、不写回存储。
    const parsed = parseDocumentContent(revision.contentJson);
    if (!parsed.ok) {
      setRestoreError("该版本内容损坏，无法恢复。");
      setConfirmId(null);
      return;
    }
    setRestoreError(null);
    // 经控制器串行化恢复（R004 INV-06）：flush 旧防抖保存 → before-restore
    // 版本 → 协调器提交目标版本 → 更新编辑器，旧保存不可能覆盖恢复结果。
    try {
      await controller.restore({
        contentJson: parsed.value,
        textSnapshot: revision.textSnapshot,
      });
    } catch {
      setRestoreError("恢复失败，请稍后重试。");
      setConfirmId(null);
      return;
    }
    setConfirmId(null);
    onClose();
  };

  return (
    <Dialog label="版本历史" className="version-panel" onClose={onClose}>
      <div className="dialog__header">
        <span>版本历史</span>
      </div>
      {restoreError && (
        <p className="version-panel__error" role="alert">
          {restoreError}
        </p>
      )}
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
                }}
              >
                <span className="version-panel__time">
                  {new Date(revision.createdAt).toLocaleString("zh-CN")}
                </span>
                <span className="version-panel__reason">
                  {REASON_LABEL[revision.reason]}
                </span>
                <span className="version-panel__snippet">
                  {revision.textSnapshot.slice(0, 40) || "（空文档）"}
                </span>
              </button>
              {previewId === revision.id && (
                <div className="version-panel__preview">
                  <div className="version-panel__text">
                    {revision.textSnapshot || "（空文档）"}
                  </div>
                  <div className="version-panel__actions">
                    <button
                      type="button"
                      className={`version-panel__restore${confirmId === revision.id ? " version-panel__restore--danger" : ""}`}
                      onClick={() => {
                        if (confirmId === revision.id) {
                          void restore(revision);
                        } else {
                          setConfirmId(revision.id);
                        }
                      }}
                    >
                      {confirmId === revision.id ? "确认恢复？" : "恢复此版本"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
