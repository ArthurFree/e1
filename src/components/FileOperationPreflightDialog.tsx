/**
 * R011 Stage 6：文件操作预检对话框——影响计数、blocker、warning、确认执行。
 */
import { useId } from "react";
import { Dialog } from "./ui/Dialog";
import type { FileOperationPlan } from "../application/fileOperations/FileOperationService";

export interface FileOperationPreflightDialogProps {
  plan: FileOperationPlan | null;
  open: boolean;
  busy?: boolean;
  errorMessage?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

function kindLabel(kind: FileOperationPlan["kind"]): string {
  switch (kind) {
    case "rename-document-file":
      return "重命名文件";
    case "move-document":
      return "移动文档";
    case "rename-group":
      return "重命名分组";
    case "move-group":
      return "移动分组";
    case "rename-workspace":
      return "重命名知识库";
    default:
      return "文件操作";
  }
}

export function FileOperationPreflightDialog({
  plan,
  open,
  busy = false,
  errorMessage = null,
  onCancel,
  onConfirm,
}: FileOperationPreflightDialogProps) {
  const titleId = useId();
  if (!open || !plan) return null;

  const blocked = plan.blockers.length > 0;
  const from = plan.target.fromRelativePath;
  const to = plan.target.toRelativePath ?? plan.target.workspaceName;

  return (
    <Dialog
      label={kindLabel(plan.kind)}
      onClose={busy ? () => undefined : onCancel}
      className="file-op-preflight-dialog"
    >
      <div className="file-op-preflight">
        <h2 id={titleId} className="file-op-preflight__title">
          {kindLabel(plan.kind)}
        </h2>
        <p className="file-op-preflight__summary">
          {from && to ? (
            <>
              <code>{from}</code> → <code>{to}</code>
            </>
          ) : plan.target.workspaceName ? (
            <>
              新名称：<strong>{plan.target.workspaceName}</strong>
              <span className="file-op-preflight__hint">
                （磁盘文件夹名称不会改变）
              </span>
            </>
          ) : (
            "请确认以下变更"
          )}
        </p>
        <ul className="file-op-preflight__counts">
          <li>移动文档：{plan.summary.movedDocuments}</li>
          <li>改写文档：{plan.summary.rewrittenDocuments}</li>
          <li>改写链接：{plan.summary.rewrittenLinks}</li>
          <li>改写附件引用：{plan.summary.rewrittenAssets}</li>
        </ul>
        {plan.blockers.length > 0 && (
          <div className="file-op-preflight__blockers" role="alert">
            <strong>无法继续</strong>
            <ul>
              {plan.blockers.map((b, i) => (
                <li key={`${b.code}-${i}`}>{b.message}</li>
              ))}
            </ul>
          </div>
        )}
        {plan.warnings.length > 0 && (
          <div className="file-op-preflight__warnings">
            <strong>注意</strong>
            <ul>
              {plan.warnings.map((w, i) => (
                <li key={`${w.code}-${i}`}>{w.message}</li>
              ))}
            </ul>
          </div>
        )}
        {errorMessage && (
          <p className="file-op-preflight__error" role="alert">
            {errorMessage}
          </p>
        )}
        <div className="file-op-preflight__actions">
          <button
            type="button"
            className="ui-button"
            onClick={onCancel}
            disabled={busy}
          >
            取消
          </button>
          <button
            type="button"
            className="ui-button ui-button--primary"
            onClick={onConfirm}
            disabled={busy || blocked}
          >
            {busy ? "执行中…" : "确认执行"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** 供树行「重命名文件…」使用的迷你确认状态钩子辅助类型。 */
export interface FileRenamePromptState {
  pageId: string;
  vaultId: string;
  fromRelativePath: string;
  newName: string;
}
