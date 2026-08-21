/**
 * 搜索索引性能基线（R008 Stage 3 §10.8 / §18）：内存参照实现占位跑通
 * benchmark 链路；Stage 4 的 Desktop SQLite 实现复用本文件同一 harness
 * （runSearchBenchmark）与语料，只换 makeIndex。
 *
 * 输出 §18 规定的 JSON 形状（console.info，[search-benchmark] 前缀，
 * 供 perf-search CI job 收集 artifact）；阈值仅作趋势参考，不设
 * wall-clock 硬门禁（vitest.perf.config.ts 约定）。
 *
 * 运行：npm run test:perf（只写不跑批次规则：本文件随统一测试执行验证）。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEARCH_VAULT_ID,
  generateSearchDocuments,
} from "../../fixtures/search/generator";
import type { FullTextSearchIndexPort } from "../application/services/SearchContract";
import { InMemoryFullTextSearchIndex } from "../infrastructure/memory/fullTextSearchIndex";

/** warm query 集：覆盖中文/英文/代码词/高频词/无命中/emoji。 */
const BENCHMARK_QUERIES = [
  "React",
  "知识库",
  "性能",
  "部署",
  "debounce",
  "guide",
  "不存在的关键词xyz",
  "🚀",
] as const;

/** §18 输出形状。 */
export interface SearchBenchmarkReport {
  documents: number;
  buildMs: number;
  queryP50Ms: number;
  queryP95Ms: number;
  updateP95Ms: number;
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return Math.round(sorted[index] * 100) / 100;
}

/**
 * benchmark 链路：prepareWorkspace → 逐条 upsert（build）→ 3 轮 warm
 * query 采样 → 20 次单文档 upsert 采样。Stage 4 换 Desktop 实现时仅
 * 替换 makeIndex。
 */
export async function runSearchBenchmark(
  makeIndex: () => FullTextSearchIndexPort,
  documentCount: number,
): Promise<SearchBenchmarkReport> {
  const documents = generateSearchDocuments(documentCount);
  const index = makeIndex();
  await index.prepareWorkspace(DEFAULT_SEARCH_VAULT_ID);

  const buildStart = performance.now();
  for (const document of documents) {
    await index.upsert(document);
  }
  const buildMs = performance.now() - buildStart;

  const querySamples: number[] = [];
  for (let round = 0; round < 3; round++) {
    for (const query of BENCHMARK_QUERIES) {
      const start = performance.now();
      const results = await index.search({
        vaultId: DEFAULT_SEARCH_VAULT_ID,
        query,
        limit: 50,
      });
      querySamples.push(performance.now() - start);
      // 链路有效性：高频词必须有命中（无命中词用于测空结果路径）。
      if (query === "React" || query === "知识库") {
        expect(results.length).toBeGreaterThan(0);
      }
    }
  }

  const updateSamples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const updated = {
      ...documents[i],
      bodyText: `${documents[i].bodyText} 增量更新`,
      versionToken: `${documents[i].versionToken}-u`,
    };
    const start = performance.now();
    await index.upsert(updated);
    updateSamples.push(performance.now() - start);
  }

  return {
    documents: documentCount,
    buildMs: Math.round(buildMs),
    queryP50Ms: percentile(querySamples, 0.5),
    queryP95Ms: percentile(querySamples, 0.95),
    updateP95Ms: percentile(updateSamples, 0.95),
  };
}

describe("搜索索引性能基线（内存参照实现）", () => {
  it("1k 文档：build + warm query + 单文档 upsert", async () => {
    const report = await runSearchBenchmark(
      () => new InMemoryFullTextSearchIndex(),
      1000,
    );
    console.info(`[search-benchmark] ${JSON.stringify(report)}`);
    expect(report.documents).toBe(1000);
  }, 60_000);

  it("10k 文档：build + warm query + 单文档 upsert", async () => {
    const report = await runSearchBenchmark(
      () => new InMemoryFullTextSearchIndex(),
      10_000,
    );
    console.info(`[search-benchmark] ${JSON.stringify(report)}`);
    expect(report.documents).toBe(10_000);
  }, 120_000);
});
