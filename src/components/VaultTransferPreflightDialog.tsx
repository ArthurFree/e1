/**
 * R014 Stage 6：Vault 搬迁 / 跨库操作预检对话框。
 */
import { useId } from "react";
import { Dialog } from "./ui/Dialog";
import type { VaultTransferPlan } from "../application/vaultTransfer/VaultTransferService";
import { VAULT_TRANSFER_LABELS } from "../../shared/vaultTransfer/types";

export interface VaultTransferPreflightDialogProps {
  plan: VaultTransferPlan | null;
  open: boolean;
  busy?: boolean;
  errorMessage?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

function kindLabel(kind: VaultTransferPlan["kind"]): string {
  switch (kind) {
    case "relocate-missing":
      return VAULT_TRANSFER_LABELS.relocateMissing;
    case "relocate-vault":
      return VAULT_TRANSFER_LABELS.relocateRoot;
    case "copy-document":
    case "copy-group":
      return VAULT_TRANSFER_LABELS.copyToVault;
    case "move-document":
    case "move-group":
      return VAULT_TRANSFER_LABELS.moveToVault;
    default:
      return "知识库操作";
  }
}

export function VaultTransferPreflightDialog({
  plan,
  open,
  busy = false,
  errorMessage = null,
  onCancel,
  onConfirm,
}: VaultTransferPreflightDialogProps) {
  const titleId = useId();
  if (!open || !plan) return null;

  const blocked = plan.blockers.length > 0;

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
          {plan.kind.startsWith("relocate-")
            ? "将更新知识库在本机的位置，不改变库内文档身份。"
            : plan.sourceRelativePath
              ? (
                <>
                  <code>{plan.sourceRelativePath}</code>
                  {plan.destinationVaultId ? (
                    <>
                      {" "}
                      → 目标知识库
                    </>
                  ) : null}
                </>
              )
              : "请确认以下变更"}
        </p>
        <ul className="file-op-preflight__counts">
          <li>文档：{plan.notes.length}</li>
          <li>附件：{plan.assets.length}</li>
          <li>版本历史：{plan.revisions.length}</li>
          <li>内部链接：{plan.linkImpacts.internal}</li>
          <li>边界入链：{plan.linkImpacts.inboundBoundary}</li>
          <li>边界出链：{plan.linkImpacts.outboundBoundary}</li>
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
