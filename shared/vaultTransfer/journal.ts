/**
 * R014：Vault 根搬迁 journal（落 Electron userData/vault-relocations/）。
 * 不放在 Vault 内——整库搬迁时源目录本身会消失。
 */
import type { VaultRelocationStrategy } from "./types.js";

export const VAULT_RELOCATION_JOURNAL_VERSION = 1 as const;

export type VaultRelocationPhase =
  | "prepared"
  | "copying"
  | "verifying"
  | "destination-ready"
  | "registry-updated"
  | "source-removing"
  | "committed"
  | "recovery-required";

export interface VaultRelocationJournal {
  version: typeof VAULT_RELOCATION_JOURNAL_VERSION;
  operationId: string;
  vaultId: string;
  sourcePath: string;
  destinationPath: string;
  strategy: VaultRelocationStrategy;
  phase: VaultRelocationPhase;
  createdAt: string;
}

export const VAULT_TRANSFER_JOURNAL_VERSION = 1 as const;

export type VaultCopyMovePhase =
  | "prepared"
  | "copying"
  | "verifying"
  | "revisions-transferring"
  | "destination-ready"
  | "source-trashing"
  | "committed"
  | "recovery-required";

export interface VaultCopyMoveJournal {
  version: typeof VAULT_TRANSFER_JOURNAL_VERSION;
  operationId: string;
  kind: "copy-document" | "copy-group" | "move-document" | "move-group";
  sourceVaultId: string;
  destinationVaultId: string;
  phase: VaultCopyMovePhase;
  createdAt: string;
}
