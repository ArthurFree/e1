/**
 * @file 回收站面板：列出软删除的页面，支持恢复、彻底删除与清空。
 * 只展示回收站「根」节点（父级不在回收站中的页面），子页面随父级一并
 * 恢复 / 级联删除，避免重复操作。彻底删除与清空都需二次点击确认
 * （首次点击进入确认态，失焦自动退出）。
 */

import { useState } from "react";
import { useApp } from "../state/AppState";
import { Dialog } from "./ui/Dialog";
import { EmptyState } from "./ui/EmptyState";
import { IconTrash, PageIcon } from "./ui/icons";

interface TrashPanelProps {
  /** 关闭面板（Escape、点击遮罩时触发）。 */
  onClose(): void;
}

/** 回收站面板：列出已删除页面，支持恢复、永久删除与清空。 */
export function TrashPanel({ onClose }: TrashPanelProps) {
  const { trashedPages, restorePage, purgePage, emptyTrash } = useApp();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  // 只展示回收站的“根”：父级也在回收站的子页面随父级一起恢复/删除。
  const trashedIds = new Set(trashedPages.map((p) => p.id));
  const roots = trashedPages.filter(
    (p) => p.parentId === null || !trashedIds.has(p.parentId),
  );

  return (
    <Dialog label="回收站" className="trash-panel" onClose={onClose}>
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
        <EmptyState title="回收站是空的。" />
      ) : (
        <div className="trash-panel__list">
          {roots.map((page) => (
            <div key={page.id} className="tree-row">
              <span className="tree-row__icon" aria-hidden="true">
                <PageIcon icon={page.icon} kind={page.kind === "group" ? "group" : "document"} size={14} />
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
                  {confirmId === page.id ? "确认" : <IconTrash size={14} />}
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
