/**
 * R014：选择目标知识库（跨库复制/移动）。
 */
import { useId } from "react";
import type { Workspace } from "../domain/types";
import { Dialog } from "./ui/Dialog";

export interface VaultPickerDialogProps {
  open: boolean;
  title: string;
  workspaces: Workspace[];
  onCancel: () => void;
  onSelect: (workspaceId: string) => void;
}

export function VaultPickerDialog({
  open,
  title,
  workspaces,
  onCancel,
  onSelect,
}: VaultPickerDialogProps) {
  const titleId = useId();
  if (!open) return null;

  return (
    <Dialog label={title} onClose={onCancel} className="file-op-preflight-dialog">
      <div className="file-op-preflight">
        <h2 id={titleId} className="file-op-preflight__title">
          {title}
        </h2>
        {workspaces.length === 0 ? (
          <p className="file-op-preflight__summary">
            没有其他可访问的知识库。请先打开目标知识库。
          </p>
        ) : (
          <ul className="file-op-preflight__counts">
            {workspaces.map((ws) => (
              <li key={ws.id}>
                <button
                  type="button"
                  className="ui-button"
                  disabled={ws.directoryAccessible === false}
                  onClick={() => onSelect(ws.id)}
                >
                  {ws.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="file-op-preflight__actions">
          <button type="button" className="ui-button" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </Dialog>
  );
}
