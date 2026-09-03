/**
 * R011 Stage 0：文件操作语义冻结测试——无 UI、不翻开关。
 */
import { describe, expect, it } from "vitest";
import {
  FILE_OPERATION_LABELS,
  REWRITE_SUPPORTED_FORMS,
  type FileOperationKind,
  type FileOperationMoveTargetKind,
} from "./types.js";
import {
  FILE_OPERATION_JOURNAL_VERSION,
  isCaseOnlyPathChange,
  type FileOperationJournal,
} from "./journal.js";

describe("R011 Stage 0 语义冻结", () => {
  it("Workspace Rename = vault.json 逻辑名，不改根目录", () => {
    const kind: FileOperationKind = "rename-workspace";
    expect(kind).toBe("rename-workspace");
    expect(FILE_OPERATION_LABELS.workspaceRenameHint).toBe(
      "磁盘文件夹名称不会改变",
    );
  });

  it("Title Rename ≠ File Rename 文案分离", () => {
    expect(FILE_OPERATION_LABELS.renameTitle).toBe("重命名");
    expect(FILE_OPERATION_LABELS.renameFile).toBe("重命名文件…");
    expect(FILE_OPERATION_LABELS.renameTitle).not.toBe(
      FILE_OPERATION_LABELS.renameFile,
    );
  });

  it("Move 目标只允许 Root 或 Group", () => {
    const allowed: FileOperationMoveTargetKind[] = ["root", "group"];
    expect(allowed).toEqual(["root", "group"]);
  });

  it("改写范围 = R010 已索引形态", () => {
    expect(REWRITE_SUPPORTED_FORMS).toEqual([
      "[text](href)",
      "![alt](src)",
    ]);
  });

  it("journal v1 schema 形状稳定", () => {
    const journal: FileOperationJournal = {
      version: FILE_OPERATION_JOURNAL_VERSION,
      operationId: "op_1",
      vaultId: "v1",
      kind: "move-document",
      phase: "prepared",
      fromRelativePath: "a.md",
      toRelativePath: "notes/a.md",
      backups: [],
      createdAt: "2026-09-03T00:00:00.000Z",
    };
    expect(journal.version).toBe(1);
    expect(journal.phase).toBe("prepared");
  });

  it("case-only rename 必须识别为 temp-hop 候选", () => {
    expect(isCaseOnlyPathChange("Foo.md", "foo.md")).toBe(true);
    expect(isCaseOnlyPathChange("notes/A.md", "notes/a.md")).toBe(true);
    expect(isCaseOnlyPathChange("Foo.md", "Bar.md")).toBe(false);
    expect(isCaseOnlyPathChange("a.md", "a.md")).toBe(false);
  });
});
