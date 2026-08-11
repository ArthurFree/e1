// R006-C3 §45 性能 sanity（不设硬 SLA，计时记录供人工参考）：
// - Vault Scan：100 目录 × 10 篇 = 1000 Markdown 初次扫描计时；
// - Note Open（Main 段）：典型 100 KB Markdown 的 readNoteFile 计时。
// Renderer 段（MarkdownCodec.parse）计时见
// src/editor/markdown/openPerf.sanity.test.ts。
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanVault } from "./VaultFileSystem.js";
import { readNoteFile } from "./NoteFileSystem.js";

/** 生成约 100 KB 的 Markdown（标题 + 重复段落）。 */
function makeLargeMarkdown(): string {
  const paragraph =
    "这是一段用于性能基准的正文文本，包含中英文混排与常用标点，用来模拟真实笔记的内容密度。\n\n";
  const body = paragraph.repeat(Math.ceil((100 * 1024) / paragraph.length));
  return `# 大文档\n\n${body}`;
}

describe("R006-C3 §45 性能 sanity（计时记录，不设硬 SLA）", () => {
  it("Vault Scan：1000 Markdown / 100 目录初次扫描", async () => {
    const root = await mkdtemp(join(tmpdir(), "e1-perf-scan-"));
    try {
      for (let d = 1; d <= 100; d += 1) {
        const dir = join(root, `目录${String(d).padStart(3, "0")}`);
        await mkdir(dir, { recursive: true });
        for (let f = 1; f <= 10; f += 1) {
          await writeFile(
            join(dir, `笔记${f}.md`),
            `# 笔记 ${d}-${f}\n\n正文。\n`,
          );
        }
      }
      const t0 = performance.now();
      const result = await scanVault(root);
      const elapsed = performance.now() - t0;
      console.log(
        `[perf] scanVault 1000 md / 100 dir 初次扫描: ${elapsed.toFixed(0)}ms`,
      );
      // 形状校验（非性能断言）：100 分组 + 1000 文档。
      expect(result.entries.filter((e) => e.kind === "group")).toHaveLength(
        100,
      );
      expect(result.entries.filter((e) => e.kind === "document")).toHaveLength(
        1000,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("Note Open（Main 段）：100 KB Markdown 的 readNoteFile", async () => {
    const root = await mkdtemp(join(tmpdir(), "e1-perf-note-"));
    try {
      await writeFile(join(root, "大文档.md"), makeLargeMarkdown());
      const t0 = performance.now();
      const result = await readNoteFile({
        vaultRoot: root,
        relativePath: "大文档.md",
      });
      const elapsed = performance.now() - t0;
      console.log(
        `[perf] readNoteFile 100 KB（含 PathGuard/UTF-8/SHA-256）: ${elapsed.toFixed(1)}ms`,
      );
      expect(result.sizeBytes).toBeGreaterThan(100 * 1024);
      expect(result.versionToken).toMatch(/^sha256:[0-9a-f]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
