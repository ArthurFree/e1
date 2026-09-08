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
  /** execute 走通 reconcile 所需的最小扫描缓存 mock。 */
  function scansStub(): DesktopVaultScanCache {
    return {
      findEntry: vi.fn(),
      invalidate: vi.fn(),
    } as unknown as DesktopVaultScanCache;
  }

  /** 直接构造 plan 并执行（plan 通道已在上方用例覆盖）。 */
  async function executePlan(
    api: ReturnType<typeof createMockDesktopApi>,
    plan: FileOperationPlanDto,
  ) {
    const service = new DesktopFileOperationService({ api, scans: scansStub() });
    return service.execute(plan as never);
  }
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

  /* -------------- R012 Stage 6（需求 §24/§39）：revision series 生命周期 -------------- */

  it("文档 rename/move：execute 后逐条 revision.relocate（stable id 直给）", async () => {
    const api = createMockDesktopApi();
    const result = await executePlan(api, basePlan());
    expect(result.pathMoves).toHaveLength(1);
    expect(api.revisions.relocate).toHaveBeenCalledTimes(1);
    expect(api.revisions.relocate).toHaveBeenCalledWith({
      vaultId: "v1",
      stableNoteId: "n1",
      fromRelativePath: "目标.md",
      toRelativePath: "改名.md",
    });
  });

  it("path-only 文档（noteKey 为 path:<rel>）：stableNoteId 缺省，按路径定位", async () => {
    const api = createMockDesktopApi();
    await executePlan(
      api,
      basePlan({
        pathMoves: [
          {
            noteKey: "path:目标.md",
            kind: "document",
            fromRelativePath: "目标.md",
            toRelativePath: "改名.md",
          },
        ],
        patches: [],
      }),
    );
    expect(api.revisions.relocate).toHaveBeenCalledWith({
      vaultId: "v1",
      stableNoteId: undefined,
      fromRelativePath: "目标.md",
      toRelativePath: "改名.md",
    });
  });

  it("revision.relocate IPC 失败：仅告警降级，不影响文件操作结果", async () => {
    const api = createMockDesktopApi({
      revisions: {
        relocate: vi.fn(async () => {
          throw new Error("ipc down");
        }),
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await executePlan(api, basePlan());
    warn.mockRestore();
    // 文件操作结果原样返回（revision 失败不标记 indexReconcileFailed）。
    expect(result.indexReconcileFailed).toBeFalsy();
    expect(result.pathMoves).toHaveLength(1);
  });

  it("分组 rename/move：prefix relocate 一次，逐文档 relocate 不重复", async () => {
    const api = createMockDesktopApi();
    await executePlan(
      api,
      basePlan({
        kind: "rename-group",
        target: { fromRelativePath: "旧组", toRelativePath: "新组" },
        pathMoves: [
          {
            noteKey: null,
            kind: "group",
            fromRelativePath: "旧组",
            toRelativePath: "新组",
          },
        ],
        patches: [],
      }),
    );
    expect(api.revisions.relocate).toHaveBeenCalledTimes(1);
    expect(api.revisions.relocate).toHaveBeenCalledWith({
      vaultId: "v1",
      fromRelativePath: "旧组",
      toRelativePath: "新组",
      prefix: true,
    });
  });

  it("分组 prefix relocate 失败：仅告警降级，不影响文件操作结果", async () => {
    const api = createMockDesktopApi({
      revisions: {
        relocate: vi.fn(async () => {
          throw new Error("ipc down");
        }),
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await executePlan(
      api,
      basePlan({
        kind: "move-group",
        target: { fromRelativePath: "旧组", toRelativePath: "归档/旧组" },
        pathMoves: [
          {
            noteKey: null,
            kind: "group",
            fromRelativePath: "旧组",
            toRelativePath: "归档/旧组",
          },
        ],
        patches: [],
      }),
    );
    warn.mockRestore();
    expect(result.indexReconcileFailed).toBeFalsy();
    expect(api.revisions.relocate).toHaveBeenCalledTimes(1);
  });
});
