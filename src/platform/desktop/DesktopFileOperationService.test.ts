/**
 * R011：DesktopFileOperationService dirty blocker / workspace rename 分流。
 */
import { describe, expect, it, vi } from "vitest";
import { DesktopFileOperationService } from "./DesktopFileOperationService";
import { createMockDesktopApi } from "../../test/createMockDesktopApi";
import type { DesktopVaultScanCache } from "./DesktopVaultScanCache";
import type { FileOperationPlanDto } from "../../../shared/ipc/contracts";

function basePlan(
  overrides: Partial<FileOperationPlanDto> = {},
): FileOperationPlanDto {
  return {
    operationId: "op_test",
    kind: "rename-document-file",
    vaultId: "v1",
    target: {
      fromRelativePath: "目标.md",
      toRelativePath: "改名.md",
    },
    pathMoves: [
      {
        noteKey: "n1",
        kind: "document",
        fromRelativePath: "目标.md",
        toRelativePath: "改名.md",
      },
    ],
    patches: [
      {
        sourcePageId: "s1",
        sourceRelativePathBefore: "来源.md",
        sourceRelativePathAfter: "来源.md",
        expectedVersionToken: "sha256:abc",
        rules: [{ kind: "internal", oldHref: "目标.md", newHref: "改名.md" }],
      },
    ],
    summary: {
      movedDocuments: 1,
      rewrittenDocuments: 1,
      rewrittenLinks: 1,
      rewrittenAssets: 0,
    },
    blockers: [],
    warnings: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("DesktopFileOperationService", () => {
  it("plan：dirty 受影响文档追加 FILE_OPERATION_BLOCKED_DIRTY", async () => {
    const api = createMockDesktopApi({
      fileOperation: {
        plan: vi.fn(async () => basePlan()),
      },
    });
    const dirty = new Set(["来源.md"]);
    const service = new DesktopFileOperationService({
      api,
      scans: {
        findEntry: vi.fn(),
      } as unknown as DesktopVaultScanCache,
      getDirtyRelativePaths: () => dirty,
    });

    const plan = await service.plan({
      kind: "rename-document-file",
      vaultId: "v1",
      fromRelativePath: "目标.md",
      newName: "改名.md",
    });
    expect(plan.blockers.some((b) => b.code === "FILE_OPERATION_BLOCKED_DIRTY")).toBe(
      true,
    );
    expect(plan.blockers[0]?.relativePath).toBe("来源.md");
  });

  it("plan：dirty 源文档（pathMoves）同样拦截", async () => {
    const api = createMockDesktopApi({
      fileOperation: {
        plan: vi.fn(async () => basePlan({ patches: [] })),
      },
    });
    const service = new DesktopFileOperationService({
      api,
      scans: {
        findEntry: vi.fn(),
      } as unknown as DesktopVaultScanCache,
      getDirtyRelativePaths: () => new Set(["目标.md"]),
    });

    const plan = await service.plan({
      kind: "rename-document-file",
      vaultId: "v1",
      fromRelativePath: "目标.md",
      newName: "改名.md",
    });
    expect(
      plan.blockers.some(
        (b) =>
          b.code === "FILE_OPERATION_BLOCKED_DIRTY" &&
          b.relativePath === "目标.md",
      ),
    ).toBe(true);
  });
});
