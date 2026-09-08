// @vitest-environment node
/**
 * R012 Stage 2：revision 组 IPC handler 测试——真实 tmp Vault +
 * 真实 DesktopRevisionStore/Identity/Retention：
 * capture（Main 读盘、去重、expectedVersionToken 复核）→ list/get →
 * prune → relocate（单文档/prefix）→ purgeSeries 全链路；
 * 未登记 vaultId → VAULT_NOT_FOUND；schema 拦截；transient 写通道拒写；
 * Stage 4：restore Safe Restore（乐观锁冲突不改盘 / Frontmatter 保留 /
 * CRLF 保持 / 自写登记）。
 */
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { IPC_CHANNELS, type IpcResult } from "../../../shared/ipc/contracts.js";
import { VaultRegistry } from "../vaultRegistry.js";
import { TransientVaultStore } from "../transientVaults.js";
import { sha256Token } from "../filesystem/AtomicFileWriter.js";
import type { IpcMainLike } from "./handler.js";
import { registerRevisionHandlers } from "./revisions.js";

type Handler = (
  event: unknown,
  payload: unknown,
) => Promise<IpcResult<unknown>>;

let handlers: Map<string, Handler>;
let vaultRoot: string;
let transients: TransientVaultStore;

const bus: IpcMainLike = {
  handle: (channel, listener) => {
    handlers.set(channel, listener as Handler);
  },
};

function call(channel: string, payload?: unknown): Promise<IpcResult<unknown>> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`handler 未注册：${channel}`);
  return handler({}, payload);
}

/** 写一份带 stable id 的笔记；返回磁盘当前 versionToken 之外无需其它。 */
async function writeNote(relativePath: string, id: string, body: string) {
  await mkdir(join(vaultRoot, ...relativePath.split("/").slice(0, -1)), {
    recursive: true,
  });
  await writeFile(
    join(vaultRoot, ...relativePath.split("/")),
    `---\nid: ${id}\ntitle: ${id}\n---\n\n${body}\n`,
  );
}

const STABLE = "01JABC";

beforeEach(async () => {
  handlers = new Map();
  const root = await mkdtemp(join(tmpdir(), "e1-rev-ipc-"));
  const registry = new VaultRegistry(join(root, "recent-vaults.json"));
  transients = new TransientVaultStore();
  vaultRoot = await mkdtemp(join(tmpdir(), "e1-rev-vault-"));
  await mkdir(join(vaultRoot, ".e1"));
  await writeFile(
    join(vaultRoot, ".e1", "vault.json"),
    JSON.stringify({
      format: "e1-vault",
      formatVersion: 1,
      vaultId: "v1",
      name: "笔记",
      createdAt: "2026-08-10T00:00:00.000Z",
      assetsDirectory: "assets",
    }),
  );
  await writeNote("甲.md", STABLE, "第一版正文");
  await registry.touch({
    vaultId: "v1",
    absolutePath: vaultRoot,
    displayName: "笔记",
  });
  registerRevisionHandlers(bus, { registry, transients });
});

const LOCATOR = { vaultId: "v1", relativePath: "甲.md", stableNoteId: STABLE };

describe("capture → list/get（Main 读盘为权威）", () => {
  it("capture 落盘后 list/get 可读；相邻同 body 去重返回 null", async () => {
    const captured = await call(IPC_CHANNELS.revisionCapture, {
      ...LOCATOR,
      reason: "manual",
      sourceVersionToken: "sha256:audit",
    });
    expect(captured).toMatchObject({
      ok: true,
      value: { reason: "manual", bodyBytes: expect.any(Number) },
    });
    const revisionId = (
      captured as { ok: true; value: { revisionId: string } }
    ).value.revisionId;

    const listed = await call(IPC_CHANNELS.revisionList, LOCATOR);
    expect(listed).toMatchObject({
      ok: true,
      value: { summaries: [{ revisionId, reason: "manual" }] },
    });

    const got = await call(IPC_CHANNELS.revisionGet, {
      ...LOCATOR,
      revisionId,
    });
    expect(got).toMatchObject({
      ok: true,
      value: {
        revisionId,
        body: "第一版正文\n",
        lineEnding: "lf",
        relativePathAtCapture: "甲.md",
      },
    });

    // 磁盘内容未变：再次 capture 去重返回 null。
    expect(
      await call(IPC_CHANNELS.revisionCapture, { ...LOCATOR, reason: "interval" }),
    ).toEqual({ ok: true, value: null });

    // 改盘后再 capture：body 为磁盘新内容（Renderer 不传正文）。
    await writeNote("甲.md", STABLE, "第二版正文");
    const second = await call(IPC_CHANNELS.revisionCapture, {
      ...LOCATOR,
      reason: "interval",
    });
    expect(second).toMatchObject({ ok: true, value: { reason: "interval" } });
    expect(
      await call(IPC_CHANNELS.revisionList, LOCATOR),
    ).toMatchObject({ ok: true, value: { summaries: { length: 2 } } });
  });

  it("expectedVersionToken 与磁盘不一致 → DOCUMENT_CONFLICT", async () => {
    const result = await call(IPC_CHANNELS.revisionCapture, {
      ...LOCATOR,
      reason: "manual",
      expectedVersionToken: "sha256:不是当前磁盘令牌",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "DOCUMENT_CONFLICT" },
    });
    expect(await call(IPC_CHANNELS.revisionList, LOCATOR)).toMatchObject({
      ok: true,
      value: { summaries: [] },
    });
  });

  it("get 不存在/损坏的 revisionId → null", async () => {
    await call(IPC_CHANNELS.revisionCapture, { ...LOCATOR, reason: "manual" });
    expect(
      await call(IPC_CHANNELS.revisionGet, { ...LOCATOR, revisionId: "r-none" }),
    ).toEqual({ ok: true, value: null });
  });
});

describe("prune / relocate / purgeSeries", () => {
  it("prune：interval 超 keep 裁剪最旧，manual 不动", async () => {
    for (let i = 0; i < 4; i += 1) {
      await writeNote("甲.md", STABLE, `第 ${i} 版`);
      await call(IPC_CHANNELS.revisionCapture, {
        ...LOCATOR,
        reason: i === 3 ? "manual" : "interval",
      });
    }
    const pruned = await call(IPC_CHANNELS.revisionPrune, {
      ...LOCATOR,
      keep: 2,
    });
    expect(pruned).toEqual({ ok: true, value: { pruned: 1 } });
    // 剩 2 个 interval + 1 个 manual。
    expect(await call(IPC_CHANNELS.revisionList, LOCATOR)).toMatchObject({
      ok: true,
      value: { summaries: { length: 3 } },
    });
  });

  it("relocate：stable-id 单文档与 prefix 分组批量", async () => {
    await call(IPC_CHANNELS.revisionCapture, { ...LOCATOR, reason: "manual" });
    // 单文档 relocate：只更新 series 当前路径元数据，历史不动。
    expect(
      await call(IPC_CHANNELS.revisionRelocate, {
        vaultId: "v1",
        stableNoteId: STABLE,
        fromRelativePath: "甲.md",
        toRelativePath: "归档/甲.md",
      }),
    ).toEqual({ ok: true, value: { relocated: 1 } });
    // 新路径仍可列到同一份历史（stable-id 系列身份不变）。
    expect(
      await call(IPC_CHANNELS.revisionList, {
        ...LOCATOR,
        relativePath: "归档/甲.md",
      }),
    ).toMatchObject({ ok: true, value: { summaries: { length: 1 } } });

    // prefix 批量：path-only 文档的孤儿 series 按前缀改写。
    await writeNote("旧组/乙.md", "02JXYZ", "乙");
    await call(IPC_CHANNELS.revisionCapture, {
      vaultId: "v1",
      relativePath: "旧组/乙.md",
      reason: "manual",
    });
    // 乙.md 有 stable id——改成无 id 文档覆盖 path-only 场景。
    await writeFile(
      join(vaultRoot, "旧组", "丙.md"),
      "---\ntitle: 丙\n---\n\n丙\n",
    );
    await call(IPC_CHANNELS.revisionCapture, {
      vaultId: "v1",
      relativePath: "旧组/丙.md",
      reason: "manual",
    });
    expect(
      await call(IPC_CHANNELS.revisionRelocate, {
        vaultId: "v1",
        fromRelativePath: "旧组",
        toRelativePath: "新组",
        prefix: true,
      }),
      // 命中 2 个 series：sn_02JXYZ（旧组/乙.md）+ 丙 的 path-only 系列
      //（relocateSeriesPrefix 按 currentRelativePath 前缀匹配全部系列）。
    ).toEqual({ ok: true, value: { relocated: 2 } });
    expect(
      await call(IPC_CHANNELS.revisionList, {
        vaultId: "v1",
        relativePath: "新组/丙.md",
      }),
    ).toMatchObject({ ok: true, value: { summaries: { length: 1 } } });
  });

  it("purgeSeries：stable-id 定位物理清理全部历史；幂等", async () => {
    await call(IPC_CHANNELS.revisionCapture, { ...LOCATOR, reason: "manual" });
    expect(
      await call(IPC_CHANNELS.revisionPurgeSeries, {
        vaultId: "v1",
        stableNoteId: STABLE,
      }),
    ).toEqual({ ok: true, value: { purged: true } });
    expect(await call(IPC_CHANNELS.revisionList, LOCATOR)).toEqual({
      ok: true,
      value: { summaries: [] },
    });
    // 幂等：再次 purge 返回 purged=false（stable-id 派生目录已不存在）。
    expect(
      await call(IPC_CHANNELS.revisionPurgeSeries, {
        vaultId: "v1",
        stableNoteId: STABLE,
      }),
    ).toEqual({ ok: true, value: { purged: false } });
    // seriesId 直给定位。
    await call(IPC_CHANNELS.revisionCapture, { ...LOCATOR, reason: "manual" });
    expect(
      await call(IPC_CHANNELS.revisionPurgeSeries, {
        vaultId: "v1",
        seriesId: `sn_${STABLE}`,
      }),
    ).toEqual({ ok: true, value: { purged: true } });
  });
});

describe("安全边界与壳通道", () => {
  it("未登记 vaultId → VAULT_NOT_FOUND（全通道）", async () => {
    for (const [channel, payload] of [
      [IPC_CHANNELS.revisionList, { ...LOCATOR, vaultId: "v-x" }],
      [
        IPC_CHANNELS.revisionGet,
        { ...LOCATOR, vaultId: "v-x", revisionId: "r1" },
      ],
      [
        IPC_CHANNELS.revisionCapture,
        { ...LOCATOR, vaultId: "v-x", reason: "manual" },
      ],
      [IPC_CHANNELS.revisionPrune, { ...LOCATOR, vaultId: "v-x" }],
      [
        IPC_CHANNELS.revisionRelocate,
        {
          vaultId: "v-x",
          fromRelativePath: "a.md",
          toRelativePath: "b.md",
        },
      ],
      [
        IPC_CHANNELS.revisionPurgeSeries,
        { vaultId: "v-x", stableNoteId: STABLE },
      ],
    ] as const) {
      expect(await call(channel, payload)).toMatchObject({
        ok: false,
        error: { code: "VAULT_NOT_FOUND" },
      });
    }
  });

describe("restore（Stage 4 Safe Restore）", () => {
  /** 计算磁盘文件当前版本令牌（与 NoteFileSystem/AtomicFileWriter 同口径）。 */
  async function diskToken(relativePath: string): Promise<string> {
    const bytes = await readFile(join(vaultRoot, ...relativePath.split("/")));
    return sha256Token(bytes);
  }

  it("成功恢复：保留当前 Frontmatter（含未知字段）、历史 body 逐字节拼回、updated 推进", async () => {
    // 带未知字段的 Frontmatter + 第一版正文
    await writeFile(
      join(vaultRoot, "甲.md"),
      "---\nid: 01JABC\ntitle: 甲\ntags: [a, b]\ncustom: 保留我\n---\n\n第一版正文\n",
    );
    const captured = await call(IPC_CHANNELS.revisionCapture, {
      ...LOCATOR,
      reason: "manual",
    });
    const revisionId = (captured as { ok: true; value: { revisionId: string } })
      .value.revisionId;
    // 外部推进到第二版（标题也改了——恢复不应回滚标题）
    await writeFile(
      join(vaultRoot, "甲.md"),
      "---\nid: 01JABC\ntitle: 甲（新）\ntags: [a, b]\ncustom: 保留我\n---\n\n第二版正文\n",
    );
    const tokenV2 = await diskToken("甲.md");

    const restored = await call(IPC_CHANNELS.revisionRestore, {
      ...LOCATOR,
      revisionId,
      expectedVersionToken: tokenV2,
    });
    expect(restored).toMatchObject({
      ok: true,
      value: { versionToken: expect.any(String), updatedAt: expect.any(Number) },
    });

    const markdown = await readFile(join(vaultRoot, "甲.md"), "utf8");
    // 当前 Frontmatter 保留（新标题/未知字段），updated 推进；
    // body 回到历史版本。
    expect(markdown).toContain("title: 甲（新）");
    expect(markdown).toContain("custom: 保留我");
    expect(markdown).toContain("updated:");
    expect(markdown.endsWith("第一版正文\n")).toBe(true);
    // 落盘令牌与磁盘一致
    expect(await diskToken("甲.md")).toBe(
      (restored as { ok: true; value: { versionToken: string } }).value
        .versionToken,
    );
  });

  it("expectedVersionToken 不符 → DOCUMENT_CONFLICT，磁盘一字节不动", async () => {
    const captured = await call(IPC_CHANNELS.revisionCapture, {
      ...LOCATOR,
      reason: "manual",
    });
    const revisionId = (captured as { ok: true; value: { revisionId: string } })
      .value.revisionId;
    const before = await readFile(join(vaultRoot, "甲.md"), "utf8");
    const result = await call(IPC_CHANNELS.revisionRestore, {
      ...LOCATOR,
      revisionId,
      expectedVersionToken: "sha256:stale",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "DOCUMENT_CONFLICT" },
    });
    expect(await readFile(join(vaultRoot, "甲.md"), "utf8")).toBe(before);
  });

  it("版本不存在 → NOTE_NOT_FOUND；schema 先于业务（缺字段 → INVALID_INPUT）", async () => {
    expect(
      await call(IPC_CHANNELS.revisionRestore, {
        ...LOCATOR,
        revisionId: "r1",
        expectedVersionToken: await diskToken("甲.md"),
      }),
    ).toMatchObject({ ok: false, error: { code: "NOTE_NOT_FOUND" } });
    expect(
      await call(IPC_CHANNELS.revisionRestore, { vaultId: "v1" }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("CRLF 文件恢复后仍 CRLF，无孤立 LF", async () => {
    await writeFile(
      join(vaultRoot, "甲.md"),
      "---\r\nid: 01JABC\r\ntitle: 甲\r\n---\r\n\r\n第一版\r\n正文\r\n",
    );
    const captured = await call(IPC_CHANNELS.revisionCapture, {
      ...LOCATOR,
      reason: "manual",
    });
    const revisionId = (captured as { ok: true; value: { revisionId: string } })
      .value.revisionId;
    await writeFile(
      join(vaultRoot, "甲.md"),
      "---\r\nid: 01JABC\r\ntitle: 甲\r\n---\r\n\r\n第二版\r\n",
    );
    const result = await call(IPC_CHANNELS.revisionRestore, {
      ...LOCATOR,
      revisionId,
      expectedVersionToken: await diskToken("甲.md"),
    });
    expect(result).toMatchObject({ ok: true });
    const markdown = await readFile(join(vaultRoot, "甲.md"), "utf8");
    expect(markdown).toContain("\r\n");
    expect(markdown.replace(/\r\n/g, "")).not.toContain("\n");
    expect(markdown.endsWith("第一版\r\n正文\r\n")).toBe(true);
  });

  it("无 Frontmatter 文档：body 即全文，恢复不添加 Frontmatter", async () => {
    await writeFile(join(vaultRoot, "乙.md"), "外部文档第一版\n");
    const pathOnly = { vaultId: "v1", relativePath: "乙.md" };
    const captured = await call(IPC_CHANNELS.revisionCapture, {
      ...pathOnly,
      reason: "manual",
    });
    const revisionId = (captured as { ok: true; value: { revisionId: string } })
      .value.revisionId;
    await writeFile(join(vaultRoot, "乙.md"), "外部文档第二版\n");
    const result = await call(IPC_CHANNELS.revisionRestore, {
      ...pathOnly,
      revisionId,
      expectedVersionToken: await diskToken("乙.md"),
    });
    expect(result).toMatchObject({ ok: true });
    expect(await readFile(join(vaultRoot, "乙.md"), "utf8")).toBe(
      "外部文档第一版\n",
    );
  });

  it("restore 落盘登记自写（SelfWriteRegistry 抑制 watcher 回声）", async () => {
    const records: string[] = [];
    handlers = new Map();
    const registry = new VaultRegistry(
      join(vaultRoot, ".e1", "recent-test.json"),
    );
    await registry.touch({
      vaultId: "v1",
      absolutePath: vaultRoot,
      displayName: "笔记",
    });
    registerRevisionHandlers(bus, {
      registry,
      transients,
      selfWrites: {
        record: (entry: { relativePath: string }) =>
          records.push(entry.relativePath),
      } as never,
    });
    const captured = await call(IPC_CHANNELS.revisionCapture, {
      ...LOCATOR,
      reason: "manual",
    });
    const revisionId = (captured as { ok: true; value: { revisionId: string } })
      .value.revisionId;
    await writeFile(join(vaultRoot, "甲.md"), "---\nid: 01JABC\n---\n\n第二版\n");
    await call(IPC_CHANNELS.revisionRestore, {
      ...LOCATOR,
      revisionId,
      expectedVersionToken: await diskToken("甲.md"),
    });
    expect(records).toContain("甲.md");
  });
});


  it("schema 拦截：路径逃逸 / 坏 id / 坏 reason", async () => {
    expect(
      await call(IPC_CHANNELS.revisionList, {
        vaultId: "v1",
        relativePath: "../甲.md",
      }),
    ).toMatchObject({ ok: false, error: { code: "PATH_ESCAPE" } });
    expect(
      await call(IPC_CHANNELS.revisionGet, { ...LOCATOR, revisionId: "../x" }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(
      await call(IPC_CHANNELS.revisionCapture, { ...LOCATOR, reason: "auto" }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("transient 仅预览：list/get 允许（只读），写通道拒写", async () => {
    const transientId = transients.add(vaultRoot, "预览");
    // 先经正常 vault 落一个快照，再验证 transient 会话可读。
    await call(IPC_CHANNELS.revisionCapture, { ...LOCATOR, reason: "manual" });
    const tLocator = { ...LOCATOR, vaultId: transientId };
    expect(await call(IPC_CHANNELS.revisionList, tLocator)).toMatchObject({
      ok: true,
      value: { summaries: { length: 1 } },
    });
    for (const [channel, payload] of [
      [IPC_CHANNELS.revisionCapture, { ...tLocator, reason: "manual" }],
      [IPC_CHANNELS.revisionPrune, tLocator],
      [
        IPC_CHANNELS.revisionRelocate,
        {
          vaultId: transientId,
          fromRelativePath: "甲.md",
          toRelativePath: "乙.md",
        },
      ],
      [
        IPC_CHANNELS.revisionRestore,
        { ...tLocator, revisionId: "r1", expectedVersionToken: "sha256:x" },
      ],
      [
        IPC_CHANNELS.revisionPurgeSeries,
        { vaultId: transientId, stableNoteId: STABLE },
      ],
    ] as const) {
      expect(await call(channel, payload)).toMatchObject({
        ok: false,
        error: { code: "VAULT_READ_ONLY" },
      });
    }
  });

  it("快照落盘为 manifest + body.md（REV-02/REV-04：不依赖 SQLite）", async () => {
    const captured = await call(IPC_CHANNELS.revisionCapture, {
      ...LOCATOR,
      reason: "manual",
    });
    const revisionId = (
      captured as { ok: true; value: { revisionId: string } }
    ).value.revisionId;
    const dir = join(
      vaultRoot,
      ".e1",
      "revisions",
      "series",
      `sn_${STABLE}`,
      "revisions",
      revisionId,
    );
    const manifest = JSON.parse(
      await readFile(join(dir, "manifest.json"), "utf8"),
    ) as { reason: string };
    expect(manifest.reason).toBe("manual");
    expect(await readFile(join(dir, "body.md"), "utf8")).toBe("第一版正文\n");
  });
});
