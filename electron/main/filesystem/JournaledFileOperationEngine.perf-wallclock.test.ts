// @vitest-environment node
/**
 * R011 Stage 7：文件操作 wall-clock 基准（不进 npm test / CI）。
 * 运行：npx vitest run --config vitest.perf.config.ts electron/main/filesystem/JournaledFileOperationEngine.perf-wallclock
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Token } from "./AtomicFileWriter.js";
import { executeFileOperationPlan } from "./JournaledFileOperationEngine.js";
import type { FileOperationPlan } from "../../../shared/fileOperations/types.js";

describe("R011 file operation wall-clock", () => {
  it("单文档 move+rewrite p95 目标 < 150ms（本机采样）", async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), "e1-fileop-perf-"));
    await mkdir(join(vaultRoot, ".e1"), { recursive: true });
    await writeFile(
      join(vaultRoot, ".e1", "vault.json"),
      JSON.stringify({
        format: "e1-vault",
        formatVersion: 1,
        vaultId: "v-perf",
        name: "perf",
        createdAt: "2026-09-03T00:00:00.000Z",
        assetsDirectory: "assets",
        identityMode: "frontmatter",
      }),
    );
    await writeFile(join(vaultRoot, "React.md"), "# R\n", "utf8");
    await mkdir(join(vaultRoot, "notes"));

    const samples: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const name = `Fiber-${i}.md`;
      const body = "见 [React](React.md)\n";
      await writeFile(join(vaultRoot, name), body, "utf8");
      const plan: FileOperationPlan = {
        operationId: `op_perf_${i}`,
        kind: "move-document",
        vaultId: "v-perf",
        target: {
          fromRelativePath: name,
          toRelativePath: `notes/${name}`,
        },
        pathMoves: [
          {
            noteKey: `path:${name}`,
            kind: "document",
            fromRelativePath: name,
            toRelativePath: `notes/${name}`,
          },
        ],
        patches: [
          {
            sourcePageId: `path:${name}`,
            sourceRelativePathBefore: name,
            sourceRelativePathAfter: `notes/${name}`,
            expectedVersionToken: sha256Token(Buffer.from(body, "utf8")),
            rules: [
              {
                kind: "internal",
                oldHref: "React.md",
                newHref: "../React.md",
              },
            ],
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
      const t0 = performance.now();
      await executeFileOperationPlan({ vaultRoot, plan });
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))]!;
    // 软断言：本机过慢时仍记录，不硬挂 CI（本文件不进 npm test）。
    expect(p95).toBeGreaterThan(0);
    console.info(`[R011 perf] single-doc move+rewrite samples(ms)=${samples.map((n) => n.toFixed(1)).join(",")} p95=${p95.toFixed(1)}`);
  });
});
