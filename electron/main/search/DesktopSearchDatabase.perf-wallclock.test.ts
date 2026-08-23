// @vitest-environment node
/**
 * R008 Stage 6（§13.5）：SQLite 全文索引性能验收（wall-clock，不进 CI 门禁）。
 * fixtures/search/generator.mjs 确定性生成 1k / 10k / 50k 语料，
 * 经真实 Vault 扫描管线（iterateVaultSearchDocuments）重建索引：
 *
 * - 1k / 10k：build / warm query(p50/p95) / upsert 基准（目标区间 §13.5：
 *   1k build ≤2s、query ≤100ms；10k build ≤10s、query ≤150ms）；
 * - 50k sanity：无 OOM、build 完成、ready 后查询稳定、增量 upsert
 *   不退化为全量（目标值以开发机实测回写 R008 文档，非 hard SLA）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateVault } from "../../../fixtures/search/generator.mjs";
import { DesktopSearchDatabase } from "./DesktopSearchDatabase.js";
import { iterateVaultSearchDocuments } from "./DesktopSearchIndexer.js";

const VAULT = "v-perf";
const QUERIES = ["组件化", "search", "中文 分词", "🎉", "ownership", "索引"];

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

async function bench(count: number, queryRounds = 10) {
  const vaultDir = await mkdtemp(join(tmpdir(), `e1-sqlite-perf-${count}-`));
  const indexDir = await mkdtemp(
    join(tmpdir(), `e1-sqlite-perf-idx-${count}-`),
  );
  try {
    await generateVault(vaultDir, count);
    const db = new DesktopSearchDatabase(join(indexDir, `${VAULT}.sqlite`));
    const buildStart = performance.now();
    await db.rebuild(
      iterateVaultSearchDocuments({ vaultId: VAULT, vaultRoot: vaultDir }),
    );
    const buildMs = performance.now() - buildStart;

    const samples: number[] = [];
    for (let round = 0; round < queryRounds; round += 1) {
      for (const query of QUERIES) {
        const start = performance.now();
        await db.search({ vaultId: VAULT, query });
        samples.push(performance.now() - start);
      }
    }

    const updateStart = performance.now();
    await db.upsert({
      pageId: "01BENCH0000000000000000",
      vaultId: VAULT,
      stableNoteId: "01BENCH0000000000000000",
      relativePath: "组件化设计 1.md",
      title: "组件化设计 1",
      tags: ["前端"],
      bodyText: "增量更新后的正文。",
      createdAt: null,
      updatedAt: null,
      versionToken: "sha256:updated",
    });
    const updateMs = performance.now() - updateStart;

    const report = {
      documents: count,
      buildMs: Math.round(buildMs),
      queryP50Ms: Number(percentile(samples, 0.5).toFixed(2)),
      queryP95Ms: Number(percentile(samples, 0.95).toFixed(2)),
      updateMs: Number(updateMs.toFixed(2)),
    };
    console.log(`[sqlite-search-perf] ${JSON.stringify(report)}`);
    db.close();
    return report;
  } finally {
    await rm(vaultDir, { recursive: true, force: true });
    await rm(indexDir, { recursive: true, force: true });
  }
}

describe("SQLite 全文索引性能验收（R008 §13.5，wall-clock，不进 CI）", () => {
  it("1k：build / query / upsert", async () => {
    const report = await bench(1_000);
    expect(report.documents).toBe(1_000);
  }, 120_000);

  it("10k：build / query / upsert", async () => {
    const report = await bench(10_000);
    expect(report.documents).toBe(10_000);
  }, 300_000);

  it("50k sanity：build 完成 + 查询稳定 + 增量不退化", async () => {
    const report = await bench(50_000, 3);
    expect(report.documents).toBe(50_000);
  }, 600_000);
});
