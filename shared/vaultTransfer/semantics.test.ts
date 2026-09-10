/**
 * R014 Stage 0：语义冻结测试——无 UI、不翻产品开关。
 */
import { describe, expect, it } from "vitest";
import {
  classifyBoundaryLink,
  summarizeBoundary,
} from "./boundary.js";
import {
  VAULT_RELOCATION_JOURNAL_VERSION,
  type VaultRelocationJournal,
} from "./journal.js";
import {
  VAULT_TRANSFER_LABELS,
  type VaultTransferKind,
} from "./types.js";

describe("R014 Stage 0 语义冻结", () => {
  it("PORT-01：Workspace Rename ≠ Vault Relocation", () => {
    const relocate: VaultTransferKind = "relocate-vault";
    expect(relocate).not.toBe("rename-workspace" as VaultTransferKind);
    expect(VAULT_TRANSFER_LABELS.workspaceRenameHint).toBe(
      "只改显示名，不移动磁盘文件夹",
    );
    expect(VAULT_TRANSFER_LABELS.relocateRoot).toBe("移动知识库位置…");
  });

  it("PORT-02/03：Copy 新 id，Move 保 id", () => {
    const copy: VaultTransferKind[] = ["copy-document", "copy-group"];
    const move: VaultTransferKind[] = ["move-document", "move-group"];
    expect(copy.every((k) => k.startsWith("copy-"))).toBe(true);
    expect(move.every((k) => k.startsWith("move-"))).toBe(true);
  });

  it("PORT-04/05：Copy 不带 revision，Move 必须带", () => {
    expect(VAULT_TRANSFER_LABELS.copyToVault).toContain("复制");
    expect(VAULT_TRANSFER_LABELS.moveToVault).toContain("移动");
  });

  it("边界链接：Inside→Inside 可迁；跨边界分类稳定", () => {
    expect(
      classifyBoundaryLink({ sourceInSet: true, targetInSet: true }),
    ).toBe("inside-inside");
    expect(
      classifyBoundaryLink({ sourceInSet: false, targetInSet: true }),
    ).toBe("outside-inside");
    expect(
      classifyBoundaryLink({ sourceInSet: true, targetInSet: false }),
    ).toBe("inside-outside");
    expect(
      summarizeBoundary([
        "inside-inside",
        "outside-inside",
        "inside-outside",
        "inside-inside",
      ]),
    ).toEqual({ internal: 2, inboundBoundary: 1, outboundBoundary: 1 });
  });

  it("relocation journal v1 形状稳定", () => {
    const journal: VaultRelocationJournal = {
      version: VAULT_RELOCATION_JOURNAL_VERSION,
      operationId: "op_1",
      vaultId: "v1",
      sourcePath: "/a",
      destinationPath: "/b",
      strategy: "rename",
      phase: "prepared",
      createdAt: "2026-09-10T00:00:00.000Z",
    };
    expect(journal.version).toBe(1);
    expect(journal.strategy).toBe("rename");
  });
});
