// @vitest-environment node
/**
 * R015.1 / M2：10k Vault Graph 端到端口径 wall-clock（不进 CI 门禁）。
 *
 * 计时口径（2026-09-21 规划冻结）：索引 ready 后，从 Renderer 发起一次
 * 图谱查询到取得可用投影的耗时，包含：
 *   Main SQLite 读取（listGraphDocs + listGraphInternalLinks）
 *   → 投影（shared/graph/project）
 *   → IPC 传输（以 structuredClone 序列化/反序列化近似）
 *   → 元数据补全（Renderer hydrate：扫描快照合并 title/relativePath/tags）。
 * structuredClone 是 IPC 的近似而非实测：真实 Electron IPC 另有进程间
 * 拷贝与事件循环延迟，此处不重复计入；结论以真实 packaged 复测为准。
 *
 * 产品目标：depth=1 p95 < 50ms、depth=2 p95 < 150ms、workspace p95 < 300ms。
 * 断言阈值保留宽松余量只防回归；是否达标看报告里的 productTargetPass。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateVault } from "../../../fixtures/search/generator.mjs";
import { DesktopLinkDatabase } from "./DesktopLinkDatabase.js";
import { iterateVaultLinkDocuments } from "./DesktopLinkIndexer.js";
import {
  projectLocalGraph,
  projectOrphans,
  projectWorkspaceGraph,
} from "../../../shared/graph/project.js";
import type { GraphDocRow, GraphLinkRow } from "../../../shared/graph/project.js";

const VAULT = "v-perf-graph";
const SAMPLES = 100;
const WARMUP = 5;

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/** Renderer hydrate 近似：扫描快照（Map）合并展示元数据。 */
function hydrate<T extends { nodes: { id: string }[] }>(
  projection: T,
  scan: Map<string, { title: string; relativePath: string; tags: string[] }>,
): T {
  for (const node of projection.nodes) {
    const meta = scan.get(node.id);
    if (meta) Object.assign(node, meta);
  }
  return projection;
}

describe("Graph 端到端性能（R015.1 M2，wall-clock，不进 CI）", () => {
  it("10k：Renderer→Main→投影→IPC→hydrate 全链路 p50/p95", async () => {
    const vaultDir = await mkdtemp(join(tmpdir(), "e1-graph-perf-"));
    const indexDir = await mkdtemp(join(tmpdir(), "e1-graph-perf-idx-"));
    try {
      const paths = await generateVault(vaultDir, 10_000, 20260910, {
        links: true,
      });
      // 生成器文件名取自标题（仅 18 种），同深度目录下重名会覆盖，
      // 磁盘实际文件数以去重后的相对路径为准。
      const expectedDocs = new Set(paths).size;
      const db = new DesktopLinkDatabase(join(indexDir, `${VAULT}.sqlite`));

      // 冷启动建索引单列，不计入查询口径。
      const coldStart = performance.now();
      await db.rebuild(
        iterateVaultLinkDocuments({ vaultId: VAULT, vaultRoot: vaultDir }),
      );
      const coldBuildMs = performance.now() - coldStart;

      const heapBefore = process.memoryUsage().heapUsed;

      // 与 Main handler 一致：每次查询重新读取全量 docs/links。
      const readAll = async (): Promise<{
        docs: GraphDocRow[];
        links: GraphLinkRow[];
      }> => ({
        docs: await db.listGraphDocs(VAULT),
        links: await db.listGraphInternalLinks(VAULT),
      });

      const { docs, links } = await readAll();
      expect(docs.length).toBe(expectedDocs);

      // 稠密节点分布：按出+入度排序取头部，记录偏斜程度。
      const degree = new Map<string, number>();
      for (const link of links) {
        degree.set(
          link.sourceNoteKey,
          (degree.get(link.sourceNoteKey) ?? 0) + 1,
        );
        if (!link.broken && link.targetNoteKey) {
          degree.set(
            link.targetNoteKey,
            (degree.get(link.targetNoteKey) ?? 0) + 1,
          );
        }
      }
      const topDegrees = [...degree.values()].sort((a, b) => b - a).slice(0, 5);

      // Renderer 侧扫描快照（会话内常驻，合法预热）。
      const scan = new Map(
        docs.map((d) => [
          d.noteKey,
          {
            title: d.title,
            relativePath: d.relativePath,
            tags: [] as string[],
          },
        ]),
      );

      const centerId = docs[0]!.noteKey;

      const runLocal = async (depth: 1 | 2): Promise<number> => {
        const start = performance.now();
        const { docs: d, links: l } = await readAll();
        const projection = projectLocalGraph({
          centerId,
          depth,
          docs: d,
          links: l,
          nodeLimit: 80,
          edgeLimit: 160,
        });
        const transferred = structuredClone(projection);
        hydrate(transferred, scan);
        return performance.now() - start;
      };

      const runWorkspace = async (): Promise<number> => {
        const start = performance.now();
        const { docs: d, links: l } = await readAll();
        const orphans = projectOrphans({ docs: d, links: l });
        const projection = projectWorkspaceGraph({
          docs: d,
          links: l,
          orphanIds: new Set(orphans.map((n) => n.id)),
          nodeLimit: 200,
          edgeLimit: 500,
        });
        const transferred = structuredClone(projection);
        hydrate(transferred, scan);
        return performance.now() - start;
      };

      const sample = async (
        run: () => Promise<number>,
      ): Promise<number[]> => {
        for (let i = 0; i < WARMUP; i += 1) await run();
        const out: number[] = [];
        for (let i = 0; i < SAMPLES; i += 1) out.push(await run());
        return out;
      };

      const depth1 = await sample(() => runLocal(1));
      const depth2 = await sample(() => runLocal(2));
      const workspace = await sample(runWorkspace);
      const heapPeak = process.memoryUsage().heapUsed - heapBefore;

      const report = {
        documents: docs.length,
        links: links.length,
        topDegrees,
        coldBuildMs: Number(coldBuildMs.toFixed(2)),
        depth1: {
          p50: Number(percentile(depth1, 0.5).toFixed(2)),
          p95: Number(percentile(depth1, 0.95).toFixed(2)),
          productTargetMs: 50,
          productTargetPass: percentile(depth1, 0.95) < 50,
        },
        depth2: {
          p50: Number(percentile(depth2, 0.5).toFixed(2)),
          p95: Number(percentile(depth2, 0.95).toFixed(2)),
          productTargetMs: 150,
          productTargetPass: percentile(depth2, 0.95) < 150,
        },
        workspace: {
          p50: Number(percentile(workspace, 0.5).toFixed(2)),
          p95: Number(percentile(workspace, 0.95).toFixed(2)),
          productTargetMs: 300,
          productTargetPass: percentile(workspace, 0.95) < 300,
        },
        heapDeltaMb: Number((heapPeak / 1024 / 1024).toFixed(1)),
        samples: SAMPLES,
      };
      console.log(`[graph-perf] ${JSON.stringify(report)}`);

      // 宽松回归阈值（防抖）；产品目标是否达成以报告为准。
      expect(report.depth1.p95).toBeLessThan(500);
      expect(report.depth2.p95).toBeLessThan(1_000);
      expect(report.workspace.p95).toBeLessThan(2_000);
      db.close();
    } finally {
      await rm(vaultDir, { recursive: true, force: true });
      await rm(indexDir, { recursive: true, force: true });
    }
  }, 300_000);
});
