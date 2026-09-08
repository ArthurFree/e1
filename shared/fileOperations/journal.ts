/**
 * R011.1（R11C-01/02）：文件操作 journal v2 schema。
 * 落盘于 `.e1/operations/<operationId>/manifest.json`；
 * 阶段机见 JournaledFileOperationEngine。
 *
 * v2 相对 v1 的核心变化：每个不可逆路径 move 逐条记录（pathSteps），
 * 每次状态翻转都先持久化 intent 再执行 fs 操作、成功后持久化 applied；
 * case-only temp-hop 的每一跳同样落盘（hopState）。
 * v1 journal 不迁移：读出 version!==2 即 unsupported-version，
 * 走 FILE_OPERATION_RECOVERY_REQUIRED（journal 生命周期短，冻结决策）。
 */
import type { FileOperationKind } from "./types.js";

export type FileOperationJournalPhase =
  | "prepared"
  | "rewriting"
  | "relocating"
  | "committed"
  | "rolling-back"
  | "recovery-required";

/** 单个 path step 的进度状态机（每步先 intent 落盘再 rename，成功后 applied）。 */
export type FileOperationStepState =
  | "pending"
  | "intent"
  | "applied"
  | "rollback-intent"
  | "rolled-back"
  | "recovery-required";

/** case-only rename 的 temp-hop 进度（仅大小写变化时两跳各自落盘）。 */
export type FileOperationHopState =
  | "none"
  | "to-hop-intent"
  | "at-hop"
  | "to-target-intent"
  | "at-target";

export interface JournalPathStep {
  id: string;
  kind: "document" | "group";
  fromRelativePath: string;
  toRelativePath: string;
  /** case-only rename 的中转路径（vault 相对）；非 case-only 为 null。 */
  hopRelativePath?: string | null;
  state: FileOperationStepState;
  hopState?: FileOperationHopState;
}

export interface FileOperationJournalBackup {
  originalRelativePath: string;
  /** 相对 journal 目录的备份路径（`backup/<sha256(路径)前16位>/<basename>`）。 */
  backupRelativePath: string;
  versionToken: string;
}

/**
 * Journal manifest v2。
 * case-only rename（仅大小写变化）在 APFS 上必须走 temp-hop：
 * `Foo.md` → `.e1/operations/<id>/tmp-hop/...` → `foo.md`，两跳均落盘。
 */
export interface FileOperationJournal {
  version: 2;
  operationId: string;
  vaultId: string;
  kind: FileOperationKind;
  phase: FileOperationJournalPhase;
  backups: FileOperationJournalBackup[];
  pathSteps: JournalPathStep[];
  createdAt: string;
}

export const FILE_OPERATION_JOURNAL_VERSION = 2 as const;

/** 判定 case-only rename：路径仅大小写不同（APFS 不区分大小写）。 */
export function isCaseOnlyPathChange(from: string, to: string): boolean {
  return from !== to && from.toLowerCase() === to.toLowerCase();
}
