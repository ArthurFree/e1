// @vitest-environment node
/**
 * R012 Stage 1（需求 §26）：DesktopRevisionRetention 测试。
 * 覆盖：keep 数量上限、5MiB 字节预算、最新 interval 恒保留、
 * manual/before-restore 永不自动删、oldest-first 确定性。
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  INTERVAL_REVISION_KEEP,
  INTERVAL_REVISION_MAX_BYTES,
} from "../../../shared/revisions/retention.js";
import { pruneIntervalRevisions } from "./DesktopRevisionRetention.js";
import { DesktopRevisionStore } from "./DesktopRevisionStore.js";

let vaultRoot: string;
let store: DesktopRevisionStore;

const SERIES = "sn_retention";

beforeEach(async () => {
  vaultRoot = await mkdtemp(join(tmpdir(), "e1-revision-retention-"));
  store = new DesktopRevisionStore(vaultRoot);
});

/** 写入新正文并捕获一个快照，返回 revisionId。 */
async function captureBody(
  body: string,
  reason: "interval" | "manual" | "before-restore" = "interval",
): Promise<string> {
  await writeFile(join(vaultRoot, "note.md"), body, "utf8");
  const manifest = await store.capture({
    seriesId: SERIES,
    relativePath: "note.md",
    reason,
    sourceVersionToken: "sha256:test",
  });
  if (!manifest) throw new Error("capture 被去重——测试正文必须互不相同");
  return manifest.revisionId;
}

describe("pruneIntervalRevisions", () => {
  it("数量上限：超出 keep 的最旧 interval 被物理删除", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(await captureBody(`# 版本 ${i}\n`));
    }
    const result = await store.list(SERIES);
    expect(result.revisions).toHaveLength(5);

    const { pruned } = await pruneIntervalRevisions(store, SERIES, 3);
    // oldest-first 确定性：被删的是最旧的 2 个（返回序为由新到旧）。
    expect(pruned).toEqual([ids[1], ids[0]]);
    const after = await store.list(SERIES);
    expect(after.revisions.map((r) => r.revisionId)).toEqual([
      ids[4],
      ids[3],
      ids[2],
    ]);
  });

  it("字节预算：累计超出 maxBytes 后最旧的先删", async () => {
    // 每个 body 10 字节（"# v0\n" 等）。
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(await captureBody(`# v${i} xxxx\n`.slice(0, 10)));
    }
    // maxBytes = 25：最新恒保留（10），再加一个累计 20 ≤ 25，
    // 继续加则 30 > 25 → 共留 2 个，最旧 3 个删除。
    const { pruned } = await pruneIntervalRevisions(store, SERIES, 100, 25);
    expect(pruned).toEqual([ids[2], ids[1], ids[0]]);
    const after = await store.list(SERIES);
    expect(after.revisions.map((r) => r.revisionId)).toEqual([ids[4], ids[3]]);
  });

  it("最新 interval 恒保留至少 1 个（即使其自身超过预算）", async () => {
    const big = `# ${"长".repeat(100)}\n`;
    const id = await captureBody(big);
    const { pruned } = await pruneIntervalRevisions(store, SERIES, 100, 1);
    expect(pruned).toEqual([]);
    const after = await store.list(SERIES);
    expect(after.revisions.map((r) => r.revisionId)).toEqual([id]);
  });

  it("manual / before-restore 永不自动删除，也不挤占 interval 计量", async () => {
    const i1 = await captureBody("# i1\n", "interval");
    await captureBody("# m1\n", "manual");
    await captureBody("# b1\n", "before-restore");
    const i2 = await captureBody("# i2\n", "interval");
    const i3 = await captureBody("# i3\n", "interval");

    // keep=1：interval 只留最新 1 个；manual/before-restore 原样保留。
    const { pruned } = await pruneIntervalRevisions(store, SERIES, 1);
    expect(pruned).toEqual([i2, i1]);
    const after = await store.list(SERIES);
    expect(after.revisions.map((r) => r.revisionId)).toContain(i3);
    expect(after.revisions.filter((r) => r.reason !== "interval")).toHaveLength(
      2,
    );
  });

  it("默认参数即策略常量：keep=100 / maxBytes=5MiB", async () => {
    expect(INTERVAL_REVISION_KEEP).toBe(100);
    expect(INTERVAL_REVISION_MAX_BYTES).toBe(5 * 1024 * 1024);
    // 未超限时 prune 不动任何快照。
    const id = await captureBody("# only\n");
    const { pruned } = await pruneIntervalRevisions(store, SERIES);
    expect(pruned).toEqual([]);
    const after = await store.list(SERIES);
    expect(after.revisions.map((r) => r.revisionId)).toEqual([id]);
  });

  it("无 series / 空 series → 无操作", async () => {
    const { pruned } = await pruneIntervalRevisions(store, "sn_empty");
    expect(pruned).toEqual([]);
  });
});
