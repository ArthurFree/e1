// @vitest-environment node
/**
 * R010 Stage 3：link 组 IPC handler 测试——真实 tmp Vault + 真实
 * SQLite 链接索引（与搜索共库）：rebuild → outgoing/backlinks/broken →
 * upsert/remove/relocate/status 全链路；未登记 vaultId → VAULT_NOT_FOUND；
 * schema 拦截；transient 仅预览允许。
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { IPC_CHANNELS, type IpcResult } from "../../../shared/ipc/contracts.js";
import { VaultRegistry } from "../vaultRegistry.js";
import { TransientVaultStore } from "../transientVaults.js";
import { DesktopVaultIndexManager } from "../index/DesktopVaultIndexManager.js";
import type { IpcMainLike } from "./handler.js";
import { registerLinkHandlers } from "./links.js";

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

beforeEach(async () => {
  handlers = new Map();
  const root = await mkdtemp(join(tmpdir(), "e1-link-ipc-"));
  const registry = new VaultRegistry(join(root, "recent-vaults.json"));
  transients = new TransientVaultStore();
  vaultRoot = await mkdtemp(join(tmpdir(), "e1-link-vault-"));
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
  await writeFile(
    join(vaultRoot, "甲.md"),
    [
      "---",
      "id: 01A",
      "title: 甲",
      "---",
      "",
      "参见 [乙](乙.md) 与 [缺失](缺失.md)。",
      "",
    ].join("\n"),
  );
  await writeFile(join(vaultRoot, "乙.md"), "回链 [甲](甲.md)。");
  await registry.touch({
    vaultId: "v1",
    absolutePath: vaultRoot,
    displayName: "笔记",
  });
  registerLinkHandlers(bus, {
    registry,
    transients,
    indexes: new DesktopVaultIndexManager(join(root, "search-index")),
  });
});

describe("link.rebuild → outgoing/backlinks/broken → 增量维护", () => {
  it("rebuild 后链接可查；broken 裁决；status ready", async () => {
    const rebuilt = await call(IPC_CHANNELS.linkRebuild, { vaultId: "v1" });
    expect(rebuilt).toMatchObject({ ok: true, value: { indexedDocuments: 2 } });
    expect(
      await call(IPC_CHANNELS.linkOutgoing, { vaultId: "v1", noteKey: "01A" }),
    ).toMatchObject({
      ok: true,
      value: [
        { label: "乙", targetPageId: "path:乙.md", broken: false },
        { label: "缺失", targetPageId: null, broken: true },
      ],
    });
    expect(
      await call(IPC_CHANNELS.linkBacklinks, { vaultId: "v1", noteKey: "01A" }),
    ).toMatchObject({
      ok: true,
      value: [{ sourcePageId: "path:乙.md", sourceTitle: "乙" }],
    });
    expect(
      await call(IPC_CHANNELS.linkBroken, { vaultId: "v1" }),
    ).toMatchObject({ ok: true, value: [{ label: "缺失", broken: true }] });
    expect(await call(IPC_CHANNELS.linkStatus, { vaultId: "v1" })).toEqual({
      ok: true,
      value: { state: "ready", indexedDocuments: 2 },
    });
  });

  it("upsert（改内容）→ remove → relocate 全链路", async () => {
    await call(IPC_CHANNELS.linkRebuild, { vaultId: "v1" });
    // 外部修改后 upsert：新增链接即时可解析。
    await writeFile(join(vaultRoot, "丙.md"), "新文档 [甲](甲.md)。");
    expect(
      await call(IPC_CHANNELS.linkUpsert, {
        vaultId: "v1",
        relativePath: "丙.md",
      }),
    ).toEqual({ ok: true, value: { indexed: true } });
    expect(
      await call(IPC_CHANNELS.linkBacklinks, { vaultId: "v1", noteKey: "01A" }),
    ).toMatchObject({ ok: true, value: { length: 2 } });
    // 移动：path 身份改键，指向它的链接同步。
    await call(IPC_CHANNELS.linkRelocate, {
      vaultId: "v1",
      fromRelativePath: "乙.md",
      toRelativePath: "归档/乙.md",
    });
    expect(
      await call(IPC_CHANNELS.linkOutgoing, { vaultId: "v1", noteKey: "01A" }),
    ).toMatchObject({
      ok: true,
      value: [{ targetPageId: "path:归档/乙.md", broken: false }, {}],
    });
    // 删除：指向它的链接翻 broken。
    await call(IPC_CHANNELS.linkRemove, {
      vaultId: "v1",
      relativePath: "归档/乙.md",
    });
    expect(
      await call(IPC_CHANNELS.linkOutgoing, { vaultId: "v1", noteKey: "01A" }),
    ).toMatchObject({
      ok: true,
      value: [{ label: "乙", targetPageId: null, broken: true }, {}],
    });
    // upsert 已消失的文件 → indexed=false。
    expect(
      await call(IPC_CHANNELS.linkUpsert, {
        vaultId: "v1",
        relativePath: "不存在.md",
      }),
    ).toEqual({ ok: true, value: { indexed: false } });
  });

  it("未登记 vaultId → VAULT_NOT_FOUND；schema 拦截链", async () => {
    expect(
      await call(IPC_CHANNELS.linkRebuild, { vaultId: "v-x" }),
    ).toMatchObject({ ok: false, error: { code: "VAULT_NOT_FOUND" } });
    for (const [channel, payload] of [
      [IPC_CHANNELS.linkOutgoing, {}],
      [IPC_CHANNELS.linkOutgoing, { vaultId: "v1" }],
      [IPC_CHANNELS.linkBroken, {}],
      [IPC_CHANNELS.linkRemove, { vaultId: "v1" }],
    ] as const) {
      expect(await call(channel, payload)).toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT" },
      });
    }
    expect(
      await call(IPC_CHANNELS.linkRemove, {
        vaultId: "v1",
        relativePath: "../x.md",
      }),
    ).toMatchObject({ ok: false, error: { code: "PATH_ESCAPE" } });
  });

  it("transient 仅预览会话允许链接索引（只读派生能力）", async () => {
    const transientId = transients.add(vaultRoot, "预览");
    const rebuilt = await call(IPC_CHANNELS.linkRebuild, {
      vaultId: transientId,
    });
    expect(rebuilt.ok).toBe(true);
    expect(
      await call(IPC_CHANNELS.linkBacklinks, {
        vaultId: transientId,
        noteKey: "01A",
      }),
    ).toMatchObject({ ok: true, value: [{ sourcePageId: "path:乙.md" }] });
  });
});
