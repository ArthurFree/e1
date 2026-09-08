// @vitest-environment node
/**
 * R012 Stage 7（§42）：Desktop 版本历史存储性能验收（wall-clock，
 * 不进 CI 门禁）。真实 tmp Vault + 真实 DesktopRevisionStore：
 *
 * - capture：1 MiB 正文快照写入（Main 读盘 → 去重 → temp-dir 原子就位）；
 * - list：100 条 summary 列表（manifest 读取，不读 body）；
 * - get：1 MiB 快照读取（lazy preview 数据源）。
 *
 * §42 初始目标：100 summaries list p95 < 100ms、1 MiB preview < 200ms、
 * 1 MiB capture < 150ms。实测校准值（开发机 macOS arm64，2026-09-08）
 * 见运行输出；断言只锁定数据规模与正确性，阈值作趋势哨兵。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DesktopRevisionStore } from "./DesktopRevisionStore.js";
import { seriesIdForStableNoteId } from "./DesktopRevisionIdentity.js";

const STABLE = "01JPERF";
const MIB = 1024 * 1024;

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/** 生成约 sizeBytes 的正文（行文本重复 + 变化后缀防去重）。 */
function makeBody(sizeBytes: number, salt: string): string {
  const line = `性能基准行：${salt}——版本历史快照正文样本，含中文与 English 混排。\n`;
  let body = "";
  while (Buffer.byteLength(body, "utf8") < sizeBytes) body += line;
  return body;
}

describe("DesktopRevisionStore 性能（§42）", () => {
  it("1 MiB capture / 100 条 list / 1 MiB get", async () => {
    const vaultDir = await mkdtemp(join(tmpdir(), "e1-rev-perf-"));
    try {
      const store = new DesktopRevisionStore(vaultDir);
      // seriesIdForStableNoteId 对不安全 id 返回 null（path-only 语义）；
      // STABLE 是安全 id，此处显式收窄供后续调用。
      const seriesId = seriesIdForStableNoteId(STABLE);
      if (seriesId === null) throw new Error("测试 id 应可派生 seriesId");
      const relativePath = "perf.md";

      // 100 条历史快照（每条 append 一行防去重）。
      for (let i = 0; i < 100; i += 1) {
        await writeFile(
          join(vaultDir, relativePath),
          `---\nid: ${STABLE}\n---\n\n第 ${i} 版\n${"x".repeat(64)}\n`,
        );
        const captured = await store.capture({
          seriesId,
          relativePath,
          reason: "interval",
          sourceVersionToken: "",
        });
        expect(captured).not.toBeNull();
      }

      // list：100 条 summary（§42 目标 p95 < 100ms）。
      const listSamples: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        const start = performance.now();
        const { revisions } = await store.list(seriesId);
        listSamples.push(performance.now() - start);
        expect(revisions).toHaveLength(100);
      }
      const listP95 = percentile(listSamples, 0.95);

      // capture：1 MiB 正文（§42 目标 p95 < 150ms）。
      const captureSamples: number[] = [];
      let bigRevisionId = "";
      for (let i = 0; i < 10; i += 1) {
        await writeFile(
          join(vaultDir, relativePath),
          `---\nid: ${STABLE}\n---\n\n${makeBody(MIB, `c${i}`)}`,
        );
        const start = performance.now();
        const captured = await store.capture({
          seriesId,
          relativePath,
          reason: "interval",
          sourceVersionToken: "",
        });
        captureSamples.push(performance.now() - start);
        expect(captured).not.toBeNull();
        bigRevisionId = captured!.revisionId;
      }
      const captureP95 = percentile(captureSamples, 0.95);

      // get：1 MiB 快照读取（lazy preview 数据源，§42 目标 p95 < 200ms）。
      const getSamples: number[] = [];
      for (let i = 0; i < 10; i += 1) {
        const start = performance.now();
        const result = await store.get(seriesId, bigRevisionId);
        getSamples.push(performance.now() - start);
        expect(result.kind).toBe("ok");
        if (result.kind === "ok") {
          expect(Buffer.byteLength(result.body, "utf8")).toBeGreaterThan(MIB);
        }
      }
      const getP95 = percentile(getSamples, 0.95);

      console.info(
        `[perf] revisions: list(100) p95=${listP95.toFixed(1)}ms ` +
          `capture(1MiB) p95=${captureP95.toFixed(1)}ms ` +
          `get(1MiB) p95=${getP95.toFixed(1)}ms`,
      );
      // 趋势哨兵（§42 初始目标，余量一个数量级内都视为健康）。
      expect(listP95).toBeLessThan(100);
      expect(captureP95).toBeLessThan(150);
      expect(getP95).toBeLessThan(200);
    } finally {
      await rm(vaultDir, { recursive: true, force: true });
    }
  }, 120_000);
});
