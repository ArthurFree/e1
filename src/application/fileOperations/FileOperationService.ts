/**
 * R011：文件操作应用契约（平台无关）。
 * Desktop 装配；Web/内存不装配（以存在性门控）。
 */
import type {
  FileOperationKind,
  FileOperationPlan,
  FileOperationRecoveryResult,
  FileOperationRecoveryStatus,
  FileOperationRequest,
  FileOperationResult,
} from "../../../shared/fileOperations/types";

export type {
  FileOperationKind,
  FileOperationPlan,
  FileOperationRecoveryResult,
  FileOperationRecoveryStatus,
  FileOperationRequest,
  FileOperationResult,
};

export interface FileOperationService {
  plan(request: FileOperationRequest): Promise<FileOperationPlan>;
  execute(plan: FileOperationPlan): Promise<FileOperationResult>;
  getRecoveryStatus(vaultId: string): Promise<FileOperationRecoveryStatus>;
  recover(vaultId: string): Promise<FileOperationRecoveryResult>;
}
