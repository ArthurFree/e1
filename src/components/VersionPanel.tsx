import { useCallback, useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";
import type { DocumentRevision, RevisionReason } from "../domain/types";
import { contentRepository, revisionRepository } from "../infrastructure/repositories";

interface VersionPanelProps {
  pageId: string;
  editor: Editor;
  onClose(): void;
}

const REASON_LABEL: Record<RevisionReason, string> = {
  interval: "自动",
  "before-restore": "恢复前",
  manual: "手动",
};

/**
 * 本地版本历史（R001 §8.3）：列表显示时间、原因和正文摘要；
 * 恢复前先把当前内容存为「恢复前」版本，再写回选中版本。
 */
export function VersionPanel({ pageId, editor, onClose }: VersionPanelProps) {
  const [revisions, setRevisions] = useState<DocumentRevision[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setRevisions(await revisionRepository.listByPage(pageId));
  }, [pageId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const restore = async (revision: DocumentRevision) => {
    // 恢复前保存当前版本，避免二次丢失。
    await revisionRepository.add(
      pageId,
      editor.getJSON(),
      editor.getText(),
      "before-restore",
    );
    editor.commands.setContent(revision.contentJson as never);
    await contentRepository.save(pageId, revision.contentJson, revision.textSnapshot);
    setConfirmId(null);
    onClose();
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog version-panel"
        role="dialog"
        aria-label="版本历史"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog__header">
          <span>版本历史</span>
        </div>
        {revisions.length === 0 ? (
          <div className="dialog__empty">暂无历史版本，编辑保存后自动记录。</div>
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
      </div>
    </div>
  );
}
