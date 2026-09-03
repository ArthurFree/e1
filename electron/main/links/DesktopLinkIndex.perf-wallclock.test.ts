// @vitest-environment node
/**
 * R010 Stage 7（§15）：SQLite 链接索引性能验收（wall-clock，不进 CI 门禁）。
 * fixtures/search/generator.mjs 确定性生成带内部链接的 1k / 10k 语料
 *（generateVault 第 4 参 { links: true }：约一半笔记各挂 1–3 条相对链接，
 * 约 1/5 指向不存在目标作 broken 语料），经真实 Vault 扫描管线
 *（iterateVaultLinkDocuments）重建索引：
 *
 * - rebuild：全量重建（第一遍快照 + 第二遍解析）；
 * - upsert：单篇文档增量更新（versionToken 变化）；
 * - backlinks / broken：查询基准（多目标轮换采样，p50/p95）。
 *
 * §15 初始目标：10k rebuild < 10s、单篇 < 100ms、backlinks < 100ms、
 * broken < 150ms。实测校准值（开发机 macOS arm64，2026-08-31）：
 * 1k rebuild ≈ 0.29s / upsert ≈ 1.4ms / backlinks p95 ≈ 0.12ms /
 * broken ≈ 0.42ms（broken 语料 167 条）；
 * 10k rebuild ≈ 2.5s / upsert ≈ 4ms / backlinks p95 ≈ 4.7ms /
 * broken ≈ 9ms（broken 语料 1766 条）——全部优于初始目标一个数量级，
 * 阈值维持 §15 初始值（余量即趋势哨兵）。
 * 与搜索基准同口径：断言只锁定数据规模与语料生效，不作 hard SLA。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateVault } from "../../../fixtures/search/generator.mjs";
import { DesktopLinkDatabase } from "./DesktopLinkDatabase.js";
import {
  iterateVaultLinkDocuments,
  linkDocumentFromMarkdown,
} from "./DesktopLinkIndexer.js";
import { readNoteFile } from "../filesystem/NoteFileSystem.js";

const VAULT = "v-perf-links";

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

async function bench(count: number) {
  const vaultDir = await mkdtemp(join(tmpdir(), `e1-links-perf-${count}-`));
  const indexDir = await mkdtemp(join(tmpdir(), `e1-links-perf-idx-${count}-`));
  try {
    const paths = await generateVault(vaultDir, count, 20260822, {
      links: true,
    });
    const db = new DesktopLinkDatabase(join(indexDir, `${VAULT}.sqlite`));

    const buildStart = performance.now();
    await db.rebuild(
      iterateVaultLinkDocuments({ vaultId: VAULT, vaultRoot: vaultDir }),
    );
    const buildMs = performance.now() - buildStart;

    // 单篇 upsert：重读首篇笔记、变更 versionToken（去重旁路）。
    const firstPath = paths[0]!;
    const first = await readNoteFile({
      vaultRoot: vaultDir,
      relativePath: firstPath,
    });
    const upsertStart = performance.now();
    await db.upsertDocument(
      linkDocumentFromMarkdown({
        vaultId: VAULT,
        relativePath: firstPath,
        markdown: first.markdown,
        versionToken: "sha256:updated",
      }),
    );
    const upsertMs = performance.now() - upsertStart;

    // backlinks：10 个不同目标轮换采样（id 规则见 generator）。
    const backlinkSamples: number[] = [];
    for (let round = 0; round < 10; round += 1) {
      const targetId = `01BENCH${String(round * 97 + 1).padStart(16, "0")}`;
      const start = performance.now();
      await db.getBacklinks(VAULT, targetId);
      backlinkSamples.push(performance.now() - start);
    }

    const brokenStart = performance.now();
    const broken = await db.getBrokenLinks(VAULT);
    const brokenMs = performance.now() - brokenStart;

    const report = {
      documents: count,
      buildMs: Math.round(buildMs),
      upsertMs: Number(upsertMs.toFixed(2)),
      backlinksP50Ms: Number(percentile(backlinkSamples, 0.5).toFixed(2)),
      backlinksP95Ms: Number(percentile(backlinkSamples, 0.95).toFixed(2)),
      brokenMs: Number(brokenMs.toFixed(2)),
      brokenCount: broken.length,
    };
    console.log(`[sqlite-links-perf] ${JSON.stringify(report)}`);
    db.close();
    return report;
  } finally {
    await rm(vaultDir, { recursive: true, force: true });
    await rm(indexDir, { recursive: true, force: true });
  }
}

describe("SQLite 链接索引性能验收（R010 §15，wall-clock，不进 CI）", () => {
  it("1k：rebuild / upsert / backlinks / broken", async () => {
    const report = await bench(1_000);
    expect(report.documents).toBe(1_000);
    // 语料生效自检：确有一定量的 broken 链接（约 1/5 的链接指向缺失目标）。
    expect(report.brokenCount).toBeGreaterThan(0);
  }, 120_000);

  it("10k：rebuild / upsert / backlinks / broken", async () => {
    const report = await bench(10_000);
    expect(report.documents).toBe(10_000);
    expect(report.brokenCount).toBeGreaterThan(0);
  }, 300_000);
});
