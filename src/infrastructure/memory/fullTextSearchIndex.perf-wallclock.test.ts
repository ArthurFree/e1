/**
 * R008 Stage 3（§10.8/§18）：全文搜索性能基准（wall-clock，不进 CI 门禁）。
 * 运行：npm run test:perf（vitest.perf.config 只收 perf-wallclock 命名文件）。
 *
 * 以 fixtures/search/generator.mjs 确定性生成 1k / 10k 语料（tmp 目录），
 * 对内存参照实现测量 build / query(p50/p95) / upsert，输出 §18 的 JSON
 * 形状（供 CI perf-observation artifact 趋势记录）；目标区间见
 * R008 §10.8（1k build 1~2s、10k build <10s、warm query <100ms 等，
 * 不作为 hard SLA）。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateVault } from "../../../fixtures/search/generator.mjs";
import { markdownToPlainText } from "../../../shared/markdown/plainText";
import { splitFrontmatter } from "../../../shared/markdown/frontmatter";
import type { SearchDocument } from "../../application/search/FullTextSearchIndex";
import { InMemoryFullTextSearchIndex } from "./fullTextSearchIndex";

const VAULT = "v-perf";
const QUERIES = ["组件化", "search", "中文 分词", "🎉", "ownership", "索引"];

async function loadCorpus(
  dir: string,
  paths: string[],
): Promise<SearchDocument[]> {
  const docs: SearchDocument[] = [];
  for (const relativePath of paths) {
    const markdown = await readFile(
      join(dir, ...relativePath.split("/")),
      "utf8",
    );
    const { metadata } = splitFrontmatter(markdown.replace(/\r\n/g, "\n"));
    docs.push({
      pageId: metadata.id ?? `path:${relativePath}`,
      vaultId: VAULT,
      stableNoteId: metadata.id ?? null,
      relativePath,
      title: metadata.title ?? relativePath,
      tags: metadata.tags,
      bodyText: markdownToPlainText(markdown),
      createdAt: null,
      updatedAt: null,
      versionToken: `sha256:${relativePath}`,
    });
  }
  return docs;
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

async function bench(count: number) {
  const dir = await mkdtemp(join(tmpdir(), `e1-search-perf-${count}-`));
  try {
    const paths = await generateVault(dir, count);
    const docs = await loadCorpus(dir, paths);

    const index = new InMemoryFullTextSearchIndex();
    const buildStart = performance.now();
    await index.rebuild(VAULT, docs);
    const buildMs = performance.now() - buildStart;

    // warm query：每个查询跑 20 次取 p50/p95。
    const samples: number[] = [];
    for (let round = 0; round < 20; round += 1) {
      for (const query of QUERIES) {
        const start = performance.now();
        await index.search({ vaultId: VAULT, query });
        samples.push(performance.now() - start);
      }
    }

    // 单文档 upsert。
    const updateStart = performance.now();
    await index.upsert({
      ...docs[0],
      bodyText: `${docs[0].bodyText}\n增量更新。`,
    });
    const updateMs = performance.now() - updateStart;

    const report = {
      documents: count,
      buildMs: Math.round(buildMs),
      queryP50Ms: Number(percentile(samples, 0.5).toFixed(2)),
      queryP95Ms: Number(percentile(samples, 0.95).toFixed(2)),
      updateMs: Number(updateMs.toFixed(2)),
    };
    console.log(`[search-perf] ${JSON.stringify(report)}`);
    return report;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("全文搜索性能基准（R008 §10.8，wall-clock，不进 CI）", () => {
  it("1k：build / query / upsert 基准", async () => {
    const report = await bench(1_000);
    expect(report.documents).toBe(1_000);
  }, 120_000);

  it("10k：build / query / upsert 基准", async () => {
    const report = await bench(10_000);
    expect(report.documents).toBe(10_000);
  }, 300_000);
});
