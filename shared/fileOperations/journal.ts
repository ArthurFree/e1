/**
 * R011 Stage 0：文件操作 journal v1 schema。
 * 落盘于 `.e1/operations/<operationId>/manifest.json`；
 * 阶段机见 JournaledFileOperationEngine。
 */
import type { FileOperationKind } from "./types.js";

export type FileOperationJournalPhase =
  | "prepared"
  | "rewriting"
  | "relocated"
  | "committed"
  | "rolling-back";

export interface FileOperationJournalBackup {
  originalRelativePath: string;
  /** 相对 journal 目录的备份路径（通常 `backup/...`）。 */
  backupRelativePath: string;
  versionToken: string;
}

/**
 * Journal manifest v1。
 * case-only rename（仅大小写变化）在 APFS 上必须走 temp-hop：
 * `Foo.md` → `.e1/operations/<id>/tmp-hop/...` → `foo.md`。
 */
export interface FileOperationJournal {
  version: 1;
  operationId: string;
  vaultId: string;
  kind: FileOperationKind;
  phase: FileOperationJournalPhase;
  fromRelativePath: string | null;
  toRelativePath: string | null;
  backups: FileOperationJournalBackup[];
  createdAt: string;
}

export const FILE_OPERATION_JOURNAL_VERSION = 1 as const;

/** 判定 case-only rename：路径仅大小写不同（APFS 不区分大小写）。 */
export function isCaseOnlyPathChange(from: string, to: string): boolean {
  return from !== to && from.toLowerCase() === to.toLowerCase();
}
