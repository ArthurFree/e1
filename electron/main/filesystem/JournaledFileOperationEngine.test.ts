// @vitest-environment node
/**
 * R011 Stage 2：JournaledFileOperationEngine 基础路径——rewrite + move + rollback。
 */
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Token } from "./AtomicFileWriter.js";
import { executeFileOperationPlan } from "./JournaledFileOperationEngine.js";
import type { FileOperationPlan } from "../../../shared/fileOperations/types.js";

let vaultRoot: string;

beforeEach(async () => {
  vaultRoot = await mkdtemp(join(tmpdir(), "e1-journal-op-"));
  await mkdir(join(vaultRoot, ".e1"), { recursive: true });
  await writeFile(
    join(vaultRoot, ".e1", "vault.json"),
    JSON.stringify({
      format: "e1-vault",
      formatVersion: 1,
      vaultId: "v-test",
      name: "测试",
      createdAt: "2026-09-03T00:00:00.000Z",
      assetsDirectory: "assets",
      identityMode: "frontmatter",
    }),
    "utf8",
  );
});

describe("JournaledFileOperationEngine", () => {
  it("先改写相对链接再移动文档", async () => {
    await writeFile(join(vaultRoot, "React.md"), "# React\n", "utf8");
    const fiberBody = "见 [React](React.md)\n";
    await writeFile(join(vaultRoot, "Fiber.md"), fiberBody, "utf8");
    await mkdir(join(vaultRoot, "notes"));
    const fiberToken = sha256Token(Buffer.from(fiberBody, "utf8"));

    const plan: FileOperationPlan = {
      operationId: "op_test_move",
      kind: "move-document",
      vaultId: "v-test",
      target: {
        fromRelativePath: "Fiber.md",
        toRelativePath: "notes/Fiber.md",
      },
      pathMoves: [
        {
          noteKey: "path:Fiber.md",
          kind: "document",
          fromRelativePath: "Fiber.md",
          toRelativePath: "notes/Fiber.md",
        },
      ],
      patches: [
        {
          sourcePageId: "path:Fiber.md",
          sourceRelativePathBefore: "Fiber.md",
          sourceRelativePathAfter: "notes/Fiber.md",
          expectedVersionToken: fiberToken,
          rules: [{ kind: "internal", oldHref: "React.md", newHref: "../React.md" }],
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
    };

    const result = await executeFileOperationPlan({ vaultRoot, plan });
    expect(result.pathMoves[0]?.toRelativePath).toBe("notes/Fiber.md");
    const moved = await readFile(join(vaultRoot, "notes", "Fiber.md"), "utf8");
    expect(moved).toContain("[React](../React.md)");
  });

  it("versionToken 不匹配 → STALE_PLAN 且文件未改", async () => {
    await writeFile(join(vaultRoot, "a.md"), "x\n", "utf8");
    const plan: FileOperationPlan = {
      operationId: "op_stale",
      kind: "move-document",
      vaultId: "v-test",
      target: { fromRelativePath: "a.md", toRelativePath: "b.md" },
      pathMoves: [
        {
          noteKey: null,
          kind: "document",
          fromRelativePath: "a.md",
          toRelativePath: "b/a.md",
        },
      ],
      patches: [
        {
          sourcePageId: "x",
          sourceRelativePathBefore: "a.md",
          sourceRelativePathAfter: "b/a.md",
          expectedVersionToken: "sha256:deadbeef",
          rules: [],
        },
      ],
      summary: {
        movedDocuments: 1,
        rewrittenDocuments: 0,
        rewrittenLinks: 0,
        rewrittenAssets: 0,
      },
      blockers: [],
      warnings: [],
      createdAt: Date.now(),
    };
    await expect(executeFileOperationPlan({ vaultRoot, plan })).rejects.toMatchObject({
      code: "FILE_OPERATION_STALE_PLAN",
    });
    expect(await readFile(join(vaultRoot, "a.md"), "utf8")).toBe("x\n");
  });
});
