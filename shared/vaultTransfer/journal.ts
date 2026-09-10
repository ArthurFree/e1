/**
 * R014.1：Vault 根搬迁 journal v2 + 跨库 Copy/Move journal。
 * 整库搬迁落 userData/vault-relocations/（不进 Vault 内）。
 * 跨库 Move 落 userData/vault-transfers/。
 * v1 搬迁 journal 不迁移：读出即 unsupported-version → manual-required。
 */
import type { VaultRelocationStrategy } from "./types.js";

export const VAULT_RELOCATION_JOURNAL_VERSION = 2 as const;

export type VaultRelocationPhase =
  | "prepared"
  | "rename-intent"
  | "rename-applied"
  | "copying"
  | "verifying"
  | "destination-ready"
  | "registry-updating"
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
  sourceFingerprint: string;
  destinationFingerprint?: string;
  createdAt: string;
  updatedAt: string;
}

export const VAULT_TRANSFER_JOURNAL_VERSION = 1 as const;

export type VaultCopyMovePhase =
  | "prepared"
  | "destination-writing"
  | "destination-ready"
  | "source-trashing"
  | "source-trashed"
  | "committed"
  | "recovery-required";

export interface VaultCopyMoveJournal {
  version: typeof VAULT_TRANSFER_JOURNAL_VERSION;
  operationId: string;
  kind: "copy-document" | "copy-group" | "move-document" | "move-group";
  sourceVaultId: string;
  destinationVaultId: string;
  sourceRelativePath: string;
  phase: VaultCopyMovePhase;
  destinationNotePaths: string[];
  destinationAssetPaths: string[];
  destinationRevisionSeries: string[];
  createdAt: string;
  updatedAt: string;
}

export type RelocationJournalRead =
  | { kind: "ok"; journal: VaultRelocationJournal }
  | { kind: "corrupt" }
  | { kind: "unsupported-version" };
