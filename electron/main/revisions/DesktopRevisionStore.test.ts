// @vitest-environment node
/**
 * R012 Stage 1（需求 §32 覆盖矩阵）：DesktopRevisionStore 测试。
 * 真实 tmp 文件系统：capture（首建目录/逐字节 body/CRLF+BOM/去重/短路）、
 * list（倒序/损坏降级/未知版本）、get（ok/missing/corrupt/body 缺失）、
 * 原子创建（temp→rename 无残留）、启动清理（partial temp dir）、
 * 写失败传播（.e1/revisions 被占为文件 / 只读目录）。
 */
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { IpcFailure } from "../../../shared/errors.js";
import type { DesktopRevisionManifest } from "../../../shared/revisions/types.js";
import {
  createRevisionId,
  DesktopRevisionStore,
  resolveRevisionSeriesRoot,
} from "./DesktopRevisionStore.js";

let vaultRoot: string;
let store: DesktopRevisionStore;

beforeEach(async () => {
  vaultRoot = await mkdtemp(join(tmpdir(), "e1-revision-store-"));
  store = new DesktopRevisionStore(vaultRoot);
});

async function writeNote(relativePath: string, content: string): Promise<void> {
  const target = join(vaultRoot, ...relativePath.split("/"));
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function revisionIds(seriesId: string): Promise<string[]> {
  const seriesRoot = await resolveRevisionSeriesRoot(vaultRoot);
  try {
    const entries = await readdir(join(seriesRoot, seriesId, "revisions"));
    return entries;
  } catch {
    return [];
  }
}

async function readSnapshot(
  seriesId: string,
  revisionId: string,
): Promise<{ manifest: DesktopRevisionManifest; body: string }> {
  const seriesRoot = await resolveRevisionSeriesRoot(vaultRoot);
  const dir = join(seriesRoot, seriesId, "revisions", revisionId);
  return {
    manifest: JSON.parse(
      await readFile(join(dir, "manifest.json"), "utf8"),
    ) as DesktopRevisionManifest,
    body: await readFile(join(dir, "body.md"), "utf8"),
  };
}

describe("capture", () => {
  it("首次 capture 自建 .e1/revisions 目录，body.md 逐字节等于 raw body", async () => {
    const markdown = "---\nid: n-1\ntitle: 笔记\n---\n\n# 标题\n\n正文一行。\n";
    await writeNote("笔记.md", markdown);

    const manifest = await store.capture({
      seriesId: "sn_n-1",
      relativePath: "笔记.md",
      reason: "interval",
      sourceVersionToken: "sha256:abc",
    });
    expect(manifest).not.toBeNull();
    expect(manifest!.version).toBe(1);
    expect(manifest!.seriesId).toBe("sn_n-1");
    expect(manifest!.reason).toBe("interval");
    expect(manifest!.relativePathAtCapture).toBe("笔记.md");
    expect(manifest!.sourceVersionToken).toBe("sha256:abc");
    expect(manifest!.lineEnding).toBe("lf");
    expect(manifest!.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest!.textPreview).toContain("正文一行");

    const snapshot = await readSnapshot("sn_n-1", manifest!.revisionId);
    // body 边界与 splitFrontmatter 同规则：闭合 `---` 行之后最多跳过一个空行。
    expect(snapshot.body).toBe("# 标题\n\n正文一行。\n");
    expect(snapshot.manifest.bodyBytes).toBe(
      Buffer.byteLength(snapshot.body, "utf8"),
    );
    expect(snapshot.manifest.bodySha256).toBe(manifest!.bodySha256);
  });

  it("BOM + CRLF：body 无 BOM（BOM 在 frontmatter 区域）、CRLF 原样保留", async () => {
    const markdown = "﻿---\r\nid: n-2\r\n---\r\n\r\n第一行\r\n第二行\r\n";
    await writeNote("crlf.md", markdown);

    const manifest = await store.capture({
      seriesId: "sn_n-2",
      relativePath: "crlf.md",
      reason: "manual",
      sourceVersionToken: "sha256:def",
    });
    expect(manifest!.lineEnding).toBe("crlf");
    const snapshot = await readSnapshot("sn_n-2", manifest!.revisionId);
    // 闭合 `---` 行后的一个空行（\r\n）被边界规则跳过，其余 CRLF 原样保留。
    expect(snapshot.body).toBe("第一行\r\n第二行\r\n");
    expect(snapshot.body.charCodeAt(0)).not.toBe(0xfeff);
    // body.md 原始字节不含 UTF-8 BOM。
    const seriesRoot = await resolveRevisionSeriesRoot(vaultRoot);
    const rawBody = await readFile(
      join(seriesRoot, "sn_n-2", "revisions", manifest!.revisionId, "body.md"),
    );
    expect(
      rawBody[0] === 0xef && rawBody[1] === 0xbb && rawBody[2] === 0xbf,
    ).toBe(false);
  });

  it("去重：当前 body 与最新快照相同 → 返回 null，不落盘", async () => {
    await writeNote("a.md", "# 甲\n");
    const first = await store.capture({
      seriesId: "sn_a",
      relativePath: "a.md",
      reason: "interval",
      sourceVersionToken: "sha256:1",
    });
    expect(first).not.toBeNull();

    const second = await store.capture({
      seriesId: "sn_a",
      relativePath: "a.md",
      reason: "interval",
      sourceVersionToken: "sha256:1",
    });
    expect(second).toBeNull();
    expect(await revisionIds("sn_a")).toEqual([first!.revisionId]);

    // body 变化后正常捕获。
    await writeNote("a.md", "# 乙\n");
    const third = await store.capture({
      seriesId: "sn_a",
      relativePath: "a.md",
      reason: "interval",
      sourceVersionToken: "sha256:2",
    });
    expect(third).not.toBeNull();
    expect((await revisionIds("sn_a")).sort()).toEqual(
      [first!.revisionId, third!.revisionId].sort(),
    );
  });

  it("expectedBodySha256 短路：与最新快照一致 → null（不重读文件）", async () => {
    await writeNote("a.md", "# 甲\n");
    const first = await store.capture({
      seriesId: "sn_a",
      relativePath: "a.md",
      reason: "interval",
      sourceVersionToken: "sha256:1",
    });
    const shortCircuited = await store.capture({
      seriesId: "sn_a",
      relativePath: "a.md",
      reason: "interval",
      sourceVersionToken: "sha256:1",
      expectedBodySha256: first!.bodySha256,
    });
    expect(shortCircuited).toBeNull();
    expect(await revisionIds("sn_a")).toEqual([first!.revisionId]);
  });

  it("原子创建：temp→rename 就位后无 .tmp- 残留，目录恰为 manifest.json + body.md", async () => {
    await writeNote("a.md", "# 甲\n");
    const manifest = await store.capture({
      seriesId: "sn_a",
      relativePath: "a.md",
      reason: "interval",
      sourceVersionToken: "sha256:1",
    });
    const ids = await revisionIds("sn_a");
    expect(ids).toEqual([manifest!.revisionId]);
    const seriesRoot = await resolveRevisionSeriesRoot(vaultRoot);
    const files = await readdir(
      join(seriesRoot, "sn_a", "revisions", manifest!.revisionId),
    );
    expect(files.sort()).toEqual(["body.md", "manifest.json"]);
  });

  it("启动清理：残留的 <revisionId>.tmp-* 目录在首次使用时被清除", async () => {
    await writeNote("a.md", "# 甲\n");
    const seriesRoot = await resolveRevisionSeriesRoot(vaultRoot);
    const stale = join(seriesRoot, "sn_a", "revisions", "01HXXX.tmp-deadbeef");
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "manifest.json"), "{}", "utf8");

    const fresh = new DesktopRevisionStore(vaultRoot);
    const result = await fresh.list("sn_a");
    expect(result.revisions).toEqual([]);
    expect(result.degraded).toEqual([]);
    await expect(stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("非法 seriesId（含路径分隔符/点）→ INVALID_INPUT", async () => {
    await writeNote("a.md", "# 甲\n");
    await expect(
      store.capture({
        seriesId: "../escape",
        relativePath: "a.md",
        reason: "interval",
        sourceVersionToken: "sha256:1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      store.capture({
        seriesId: "a/b",
        relativePath: "a.md",
        reason: "interval",
        sourceVersionToken: "sha256:1",
      }),
    ).rejects.toBeInstanceOf(IpcFailure);
  });

  it("写失败传播：.e1/revisions 被占为文件 → capture 拒绝且不产生快照", async () => {
    await writeNote("a.md", "# 甲\n");
    await mkdir(join(vaultRoot, ".e1"), { recursive: true });
    await writeFile(join(vaultRoot, ".e1", "revisions"), "占位", "utf8");

    await expect(
      store.capture({
        seriesId: "sn_a",
        relativePath: "a.md",
        reason: "interval",
        sourceVersionToken: "sha256:1",
      }),
    ).rejects.toThrow();
    // 源文件未被改动。
    expect(await readFile(join(vaultRoot, "a.md"), "utf8")).toBe("# 甲\n");
  });

  it("写失败传播：series 存储只读 → capture 拒绝", async (context) => {
    // root 下 chmod 不生效（权限检查被绕过），跳过。
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      context.skip();
    }
    await writeNote("a.md", "# 甲\n");
    const seriesRoot = await resolveRevisionSeriesRoot(vaultRoot);
    await mkdir(seriesRoot, { recursive: true });
    await chmod(seriesRoot, 0o444);
    try {
      await expect(
        store.capture({
          seriesId: "sn_a",
          relativePath: "a.md",
          reason: "interval",
          sourceVersionToken: "sha256:1",
        }),
      ).rejects.toThrow();
    } finally {
      await chmod(seriesRoot, 0o755);
    }
  });

  it("笔记不存在 → NOTE_NOT_FOUND", async () => {
    await expect(
      store.capture({
        seriesId: "sn_a",
        relativePath: "不存在.md",
        reason: "interval",
        sourceVersionToken: "sha256:1",
      }),
    ).rejects.toMatchObject({ code: "NOTE_NOT_FOUND" });
  });
});

describe("list", () => {
  it("createdAt 倒序（最新在前）；同毫秒由单调 revisionId 保证次序", async () => {
    await writeNote("a.md", "# v1\n");
    const ids: string[] = [];
    for (let i = 1; i <= 3; i += 1) {
      await writeNote("a.md", `# v${i}\n`);
      const manifest = await store.capture({
        seriesId: "sn_a",
        relativePath: "a.md",
        reason: "interval",
        sourceVersionToken: `sha256:${i}`,
      });
      ids.push(manifest!.revisionId);
    }
    const { revisions, degraded } = await store.list("sn_a");
    expect(degraded).toEqual([]);
    expect(revisions.map((r) => r.revisionId)).toEqual([
      ids[2],
      ids[1],
      ids[0],
    ]);
  });

  it("corrupt manifest：单条降级进 degraded，其余正常返回", async () => {
    await writeNote("a.md", "# v1\n");
    const good = await store.capture({
      seriesId: "sn_a",
      relativePath: "a.md",
      reason: "interval",
      sourceVersionToken: "sha256:1",
    });
    await writeNote("a.md", "# v2\n");
    await store.capture({
      seriesId: "sn_a",
      relativePath: "a.md",
      reason: "manual",
      sourceVersionToken: "sha256:2",
    });

    // 损坏其中一条 manifest。
    const seriesRoot = await resolveRevisionSeriesRoot(vaultRoot);
    await writeFile(
      join(seriesRoot, "sn_a", "revisions", good!.revisionId, "manifest.json"),
      "not json",
      "utf8",
    );

    const { revisions, degraded } = await store.list("sn_a");
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.reason).toBe("manual");
    expect(degraded).toEqual([
      { revisionId: good!.revisionId, reason: "manifest 不是合法 JSON" },
    ]);
  });

  it("unknown manifest version：跳过该条并进 degraded", async () => {
    await writeNote("a.md", "# v1\n");
    const manifest = await store.capture({
      seriesId: "sn_a",
      relativePath: "a.md",
      reason: "interval",
      sourceVersionToken: "sha256:1",
    });
    const seriesRoot = await resolveRevisionSeriesRoot(vaultRoot);
    const manifestPath = join(
      seriesRoot,
      "sn_a",
      "revisions",
      manifest!.revisionId,
      "manifest.json",
    );
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    raw.version = 2;
    await writeFile(manifestPath, JSON.stringify(raw), "utf8");

    const { revisions, degraded } = await store.list("sn_a");
    expect(revisions).toEqual([]);
    expect(degraded).toHaveLength(1);
    expect(degraded[0]!.revisionId).toBe(manifest!.revisionId);
    expect(degraded[0]!.reason).toContain("版本");
  });

  it("manifest 缺失的半截目录 → degraded，不拖垮列表", async () => {
    await writeNote("a.md", "# v1\n");
    await store.capture({
      seriesId: "sn_a",
      relativePath: "a.md",
      reason: "interval",
      sourceVersionToken: "sha256:1",
    });
    const seriesRoot = await resolveRevisionSeriesRoot(vaultRoot);
    await mkdir(
      join(seriesRoot, "sn_a", "revisions", "01HZZZAAAAAAAAAAAAAAA1"),
    );

    const { revisions, degraded } = await store.list("sn_a");
    expect(revisions).toHaveLength(1);
    expect(degraded).toEqual([
      {
        revisionId: "01HZZZAAAAAAAAAAAAAAA1",
        reason: "manifest.json 缺失",
      },
    ]);
  });
});

describe("get", () => {
  it("按 revisionId 读回 manifest + body", async () => {
    await writeNote("a.md", "# 甲\n\n内容。\n");
    const manifest = await store.capture({
      seriesId: "sn_a",
      relativePath: "a.md",
      reason: "manual",
      sourceVersionToken: "sha256:1",
    });
    const read = await store.get("sn_a", manifest!.revisionId);
    expect(read.kind).toBe("ok");
    if (read.kind === "ok") {
      expect(read.manifest.revisionId).toBe(manifest!.revisionId);
      expect(read.body).toBe("# 甲\n\n内容。\n");
    }
  });

  it("不存在的 revisionId → missing", async () => {
    const read = await store.get("sn_a", createRevisionId());
    expect(read.kind).toBe("missing");
  });

  it("manifest 损坏 → corrupt；body.md 缺失 → corrupt", async () => {
    await writeNote("a.md", "# v1\n");
    const m1 = await store.capture({
      seriesId: "sn_a",
      relativePath: "a.md",
      reason: "interval",
      sourceVersionToken: "sha256:1",
    });
    await writeNote("a.md", "# v2\n");
    const m2 = await store.capture({
      seriesId: "sn_a",
      relativePath: "a.md",
      reason: "interval",
      sourceVersionToken: "sha256:2",
    });
    const seriesRoot = await resolveRevisionSeriesRoot(vaultRoot);
    await writeFile(
      join(seriesRoot, "sn_a", "revisions", m1!.revisionId, "manifest.json"),
      "{broken",
      "utf8",
    );
    await rm(join(seriesRoot, "sn_a", "revisions", m2!.revisionId, "body.md"));

    expect((await store.get("sn_a", m1!.revisionId)).kind).toBe("corrupt");
    expect((await store.get("sn_a", m2!.revisionId)).kind).toBe("corrupt");
  });
});

describe("createRevisionId", () => {
  it("单调：同毫秒连续生成 id 严格递增（26 字符大写 ULID）", () => {
    const now = Date.now();
    const ids = Array.from({ length: 100 }, () => createRevisionId(now));
    for (const id of ids) {
      expect(id).toMatch(/^[0-9A-Z]{26}$/);
    }
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(100);
  });
});
