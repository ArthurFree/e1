import { useEffect, useState } from "react";
import { useApp } from "../state/AppState";

interface TrashPanelProps {
  onClose(): void;
}

/** 回收站面板：列出已删除页面，支持恢复、永久删除与清空。 */
export function TrashPanel({ onClose }: TrashPanelProps) {
  const { trashedPages, restorePage, purgePage, emptyTrash } = useApp();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // 只展示回收站的“根”：父级也在回收站的子页面随父级一起恢复/删除。
  const trashedIds = new Set(trashedPages.map((p) => p.id));
  const roots = trashedPages.filter(
    (p) => p.parentId === null || !trashedIds.has(p.parentId),
  );

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog trash-panel"
        role="dialog"
        aria-label="回收站"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog__header">
          <span>回收站</span>
          {roots.length > 0 && (
            <button
              type="button"
              className="trash-panel__empty-all"
              onClick={() => {
                if (confirmEmpty) {
                  void emptyTrash();
                  setConfirmEmpty(false);
                } else {
                  setConfirmEmpty(true);
                }
              }}
              onBlur={() => setConfirmEmpty(false)}
            >
              {confirmEmpty ? "确认清空？" : "清空回收站"}
            </button>
          )}
        </div>
        {roots.length === 0 ? (
          <div className="dialog__empty">回收站是空的。</div>
        ) : (
          <div className="trash-panel__list">
            {roots.map((page) => (
              <div key={page.id} className="tree-row">
                <span className="tree-row__icon" aria-hidden="true">
                  {page.icon ?? (page.kind === "folder" ? "📁" : "📄")}
                </span>
                <span
                  className={`tree-row__title${page.title ? "" : " tree-row__title--untitled"}`}
                >
                  {page.title || "无标题"}
                </span>
                <span className="trash-panel__date">
                  {page.deletedAt
                    ? new Date(page.deletedAt).toLocaleDateString("zh-CN")
                    : ""}
                </span>
                <span className="tree-row__actions">
                  <button
                    type="button"
                    className="tree-row__action"
                    aria-label={`恢复「${page.title || "无标题"}」`}
                    title="恢复"
                    onClick={() => void restorePage(page.id)}
                  >
                    ↩
                  </button>
                  <button
                    type="button"
                    className={`tree-row__action${confirmId === page.id ? " tree-row__action--danger" : ""}`}
                    aria-label={`彻底删除「${page.title || "无标题"}」`}
                    title={confirmId === page.id ? "确认彻底删除" : "彻底删除"}
                    onClick={() => {
                      if (confirmId === page.id) {
                        void purgePage(page.id);
                        setConfirmId(null);
                      } else {
                        setConfirmId(page.id);
                      }
                    }}
                    onBlur={() => setConfirmId(null)}
                  >
                    {confirmId === page.id ? "确认" : "🗑️"}
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
