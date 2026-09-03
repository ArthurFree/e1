/**
 * R011 Stage 0：文件操作共享类型——Plan / Request / Result / Recovery。
 * 环境中立、零依赖；Main / Renderer / application 共用同一契约。
 */

/** 路径变更类操作种类（不含 trash / restore）。 */
export type FileOperationKind =
  | "rename-document-file"
  | "move-document"
  | "rename-group"
  | "move-group"
  | "rename-workspace";

/** 单条路径映射（文档或分组目录）。 */
export interface FilePathMove {
  noteKey: string | null;
  kind: "document" | "group";
  fromRelativePath: string;
  toRelativePath: string;
}

/** Markdown 目的地改写规则（只改 href，不改 label）。 */
export interface MarkdownLinkPatchRule {
  kind: "internal" | "asset";
  oldHref: string;
  newHref: string;
}

/** 单篇文档的 Markdown 改写计划（含乐观锁令牌）。 */
export interface MarkdownLinkPatchPlan {
  sourcePageId: string;
  sourceRelativePathBefore: string;
  sourceRelativePathAfter: string;
  expectedVersionToken: string;
  rules: MarkdownLinkPatchRule[];
}

/** 计划中的阻断或警告项。 */
export interface FileOperationIssue {
  code: string;
  message: string;
  pageId?: string;
  relativePath?: string;
}

/** 预检计划（plan → 用户确认 → execute）。 */
export interface FileOperationPlan {
  operationId: string;
  kind: FileOperationKind;
  vaultId: string;
  target: {
    pageId?: string;
    fromRelativePath?: string;
    toRelativePath?: string;
    workspaceName?: string;
  };
  pathMoves: FilePathMove[];
  patches: MarkdownLinkPatchPlan[];
  summary: {
    movedDocuments: number;
    rewrittenDocuments: number;
    rewrittenLinks: number;
    rewrittenAssets: number;
  };
  blockers: FileOperationIssue[];
  warnings: FileOperationIssue[];
  createdAt: number;
}

/** plan 请求（Renderer 只传 vaultId / pageId / relativePath，不见绝对路径）。 */
export interface FileOperationRequest {
  kind: FileOperationKind;
  vaultId: string;
  pageId?: string;
  fromRelativePath?: string;
  toRelativePath?: string;
  /** rename-document-file：新文件名（含 .md）；rename-group：新目录名。 */
  newName?: string;
  /** rename-workspace：新逻辑名（只写 vault.json）。 */
  workspaceName?: string;
}

export interface FileOperationResult {
  operationId: string;
  kind: FileOperationKind;
  vaultId: string;
  pathMoves: FilePathMove[];
  rewrittenDocuments: number;
  rewrittenLinks: number;
  /** 派生索引 reconcile 失败时为 true（不回滚已成功的 Markdown/路径操作）。 */
  indexReconcileFailed?: boolean;
}

export type FileOperationRecoveryPhase =
  | "clean"
  | "recoverable"
  | "manual-required";

export interface FileOperationRecoveryStatus {
  vaultId: string;
  phase: FileOperationRecoveryPhase;
  pendingOperationIds: string[];
  message?: string;
}

export interface FileOperationRecoveryResult {
  vaultId: string;
  recovered: boolean;
  rolledBackOperationIds: string[];
  message?: string;
}

/** UI 文案冻结（R11-002）：标题改名 ≠ 文件改名。 */
export const FILE_OPERATION_LABELS = {
  renameTitle: "重命名",
  renameFile: "重命名文件…",
  workspaceRenameHint: "磁盘文件夹名称不会改变",
} as const;

/** 改写范围冻结（R11-004）：仅 R010 已索引形态。 */
export const REWRITE_SUPPORTED_FORMS = [
  "[text](href)",
  "![alt](src)",
] as const;

/** 移动目标冻结（R11-003）：只允许 Root 或 Group。 */
export type FileOperationMoveTargetKind = "root" | "group";
