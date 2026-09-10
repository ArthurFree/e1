/**
 * R014：Vault 搬迁与跨库复制/移动应用契约。
 * Desktop 装配；Web/内存不装配（以存在性门控）。
 */
import type {
  VaultTransferPlan,
  VaultTransferRecoveryResult,
  VaultTransferRecoveryStatus,
  VaultTransferRequest,
  VaultTransferResult,
} from "../../../shared/vaultTransfer/types";

export type {
  VaultTransferPlan,
  VaultTransferRecoveryResult,
  VaultTransferRecoveryStatus,
  VaultTransferRequest,
  VaultTransferResult,
};

export type VaultTransferPlanRequest = VaultTransferRequest & {
  /** Renderer 可用页面 id；Desktop 经 ScanCache 译成 relativePath。 */
  pageId?: string;
};

export interface VaultTransferService {
  plan(request: VaultTransferPlanRequest): Promise<VaultTransferPlan>;
  execute(plan: VaultTransferPlan): Promise<VaultTransferResult>;
  getRecoveryStatus(): Promise<VaultTransferRecoveryStatus>;
  recover(): Promise<VaultTransferRecoveryResult>;
  /** 原生目录选择，返回一次性 selectionToken；取消为 null。 */
  pickDirectory(): Promise<string | null>;
}
