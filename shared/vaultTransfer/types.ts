/**
 * R014 Stage 0：Vault 可移植性与跨库操作共享类型。
 * 环境中立、零依赖；Main / Renderer / application 共用同一契约。
 *
 * PORT-01：workspace.rename ≠ Vault Relocation
 * PORT-02：Copy 生成新 stable note id
 * PORT-03：Move 保持 stable note id
 * PORT-04：Copy 默认不复制 revision history
 * PORT-05：Move 必须迁移 revision history
 * PORT-06：canonical 链接仍是普通 Markdown 相对路径
 */

export type VaultTransferKind =
  | "relocate-missing"
  | "relocate-vault"
  | "copy-document"
  | "copy-group"
  | "move-document"
  | "move-group";

export type VaultRelocationStrategy = "rename" | "copy-verify-delete";

export interface VaultTransferIssue {
  code: string;
  message: string;
  pageId?: string;
  relativePath?: string;
}

export interface VaultTransferNotePlan {
  sourcePath: string;
  destinationPath: string;
  sourceStableId: string | null;
  destinationStableId: string;
}

export interface VaultTransferAssetPlan {
  sourcePath: string;
  destinationPath: string;
  sha256: string;
  reuseExisting: boolean;
}

export interface VaultTransferRevisionPlan {
  sourceSeriesId: string;
  destinationSeriesId: string;
  stableNoteId: string;
}

export interface VaultTransferDirectoryPlan {
  sourcePath: string;
  destinationPath: string;
}

export interface VaultTransferLinkImpacts {
  internal: number;
  inboundBoundary: number;
  outboundBoundary: number;
}

export interface VaultTransferPlan {
  operationId: string;
  kind: VaultTransferKind;
  sourceVaultId: string;
  destinationVaultId?: string;
  sourceRelativePath?: string;
  destinationRelativePath?: string;
  /** relocate-vault：目标父目录由 selectionToken 解析；此为将创建的文件夹名。 */
  newFolderName?: string;
  /** relocate-*：Main 写入、execute 复核，Renderer 不得伪造。 */
  destinationSelectionToken?: string;
  notes: VaultTransferNotePlan[];
  directories: VaultTransferDirectoryPlan[];
  assets: VaultTransferAssetPlan[];
  revisions: VaultTransferRevisionPlan[];
  linkImpacts: VaultTransferLinkImpacts;
  blockers: VaultTransferIssue[];
  warnings: VaultTransferIssue[];
  strategy?: VaultRelocationStrategy;
  /** 源/目标指纹，execute 前复核，失配 → VAULT_TRANSFER_STALE_PLAN。 */
  sourceFingerprint: string;
  destinationFingerprint: string;
  createdAt: string;
}

/** Renderer 只传 vaultId / relativePath / selectionToken，不见绝对路径。 */
export interface VaultTransferRequest {
  kind: VaultTransferKind;
  sourceVaultId: string;
  destinationVaultId?: string;
  sourceRelativePath?: string;
  destinationRelativePath?: string;
  selectionToken?: string;
  newFolderName?: string;
}

export interface VaultTransferResult {
  operationId: string;
  kind: VaultTransferKind;
  sourceVaultId: string;
  destinationVaultId?: string;
  notesCopied: number;
  assetsCopied: number;
  revisionsTransferred: number;
  sourceTrashed: boolean;
  indexReconcileFailed?: boolean;
}

export type VaultTransferRecoveryPhase =
  | "clean"
  | "recoverable"
  | "manual-required";

export interface VaultTransferRecoveryStatus {
  operationId?: string;
  phase: VaultTransferRecoveryPhase;
  pendingOperationIds: string[];
  message?: string;
}

export interface VaultTransferRecoveryResult {
  recovered: boolean;
  rolledBackOperationIds: string[];
  message?: string;
}

export const VAULT_TRANSFER_LABELS = {
  relocateMissing: "重新定位知识库…",
  relocateRoot: "移动知识库位置…",
  copyToVault: "复制到其他知识库…",
  moveToVault: "移动到其他知识库…",
  workspaceRenameHint: "只改显示名，不移动磁盘文件夹",
} as const;

export const VAULT_TRANSFER_BLOCKER_CODES = {
  vaultIdMismatch: "VAULT_ID_MISMATCH",
  sourceAccessible: "VAULT_SOURCE_STILL_ACCESSIBLE",
  destNotEmpty: "VAULT_DESTINATION_NOT_EMPTY",
  destInsideSource: "VAULT_DESTINATION_INSIDE_SOURCE",
  collision: "VAULT_TRANSFER_COLLISION",
  boundaryInbound: "VAULT_TRANSFER_BOUNDARY_INBOUND",
  boundaryOutbound: "VAULT_TRANSFER_BOUNDARY_OUTBOUND",
  stalePlan: "VAULT_TRANSFER_STALE_PLAN",
  dirty: "VAULT_TRANSFER_BLOCKED_DIRTY",
  destSameVault: "VAULT_TRANSFER_SAME_VAULT",
  identityCollision: "VAULT_TRANSFER_IDENTITY_COLLISION",
  revisionCollision: "VAULT_TRANSFER_REVISION_COLLISION",
} as const;
