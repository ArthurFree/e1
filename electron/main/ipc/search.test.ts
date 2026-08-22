// @vitest-environment node
/**
 * R008 Stage 4：search 组 IPC handler 测试——真实 tmp Vault + 真实
 * SQLite 索引库：rebuild → query（中文/title/body）→ upsert/remove/
 * relocate/status 全链路；未登记 vaultId → VAULT_NOT_FOUND；schema 拦截。
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { IPC_CHANNELS, type IpcResult } from "../../../shared/ipc/contracts.js";
import { VaultRegistry } from "../vaultRegistry.js";
import { TransientVaultStore } from "../transientVaults.js";
import { DesktopSearchIndexManager } from "../search/DesktopSearchDatabase.js";
import type { IpcMainLike } from "./handler.js";
import { registerSearchHandlers } from "./search.js";

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
  const root = await mkdtemp(join(tmpdir(), "e1-search-ipc-"));
  const registry = new VaultRegistry(join(root, "recent-vaults.json"));
  transients = new TransientVaultStore();
  vaultRoot = await mkdtemp(join(tmpdir(), "e1-search-vault-"));
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
  await mkdir(join(vaultRoot, "学习"));
  await writeFile(
    join(vaultRoot, "学习", "React.md"),
    [
      "---",
      "id: 01S1",
      "title: React 笔记",
      "tags: [前端]",
      "---",
      "",
      "组件化与 Hooks 要点。",
      "",
    ].join("\n"),
  );
  await writeFile(join(vaultRoot, "随想.md"), "今天研究了中文分词方案。");
  await registry.touch({
    vaultId: "v1",
    absolutePath: vaultRoot,
    displayName: "笔记",
  });
  registerSearchHandlers(bus, {
    registry,
    transients,
    indexes: new DesktopSearchIndexManager(join(root, "search-index")),
  });
});

describe("search.rebuild → query → 增量维护", () => {
  it("rebuild 后中文/title/tag/body 可查；status ready", async () => {
    const rebuilt = await call(IPC_CHANNELS.searchRebuild, { vaultId: "v1" });
    expect(rebuilt).toMatchObject({ ok: true, value: { indexedDocuments: 2 } });
    expect(
      await call(IPC_CHANNELS.searchQuery, { vaultId: "v1", query: "组件化" }),
    ).toMatchObject({
      ok: true,
      value: [{ pageId: "01S1", matchedField: "body" }],
    });
    expect(
      await call(IPC_CHANNELS.searchQuery, { vaultId: "v1", query: "React" }),
    ).toMatchObject({ ok: true, value: [{ matchedField: "title" }] });
    expect(
      await call(IPC_CHANNELS.searchQuery, { vaultId: "v1", query: "前端" }),
    ).toMatchObject({ ok: true, value: [{ matchedField: "tag" }] });
    expect(
      await call(IPC_CHANNELS.searchQuery, { vaultId: "v1", query: "分词" }),
    ).toMatchObject({
      ok: true,
      value: [{ pageId: "path:随想.md", matchedField: "body" }],
    });
    expect(await call(IPC_CHANNELS.searchStatus, { vaultId: "v1" })).toEqual({
      ok: true,
      value: { state: "ready", indexedDocuments: 2 },
    });
  });

  it("upsert（改内容）→ remove → relocate 全链路", async () => {
    await call(IPC_CHANNELS.searchRebuild, { vaultId: "v1" });
    // 外部修改后 upsert。
    await writeFile(join(vaultRoot, "随想.md"), "全新的内容，改谈索引与检索。");
    expect(
      await call(IPC_CHANNELS.searchUpsert, {
        vaultId: "v1",
        relativePath: "随想.md",
      }),
    ).toEqual({ ok: true, value: { indexed: true } });
    expect(
      await call(IPC_CHANNELS.searchQuery, { vaultId: "v1", query: "分词" }),
    ).toEqual({ ok: true, value: [] });
    // 移动。
    await call(IPC_CHANNELS.searchRelocate, {
      vaultId: "v1",
      from: "随想.md",
      to: "学习/随想.md",
    });
    expect(
      await call(IPC_CHANNELS.searchQuery, { vaultId: "v1", query: "索引" }),
    ).toMatchObject({
      ok: true,
      value: [{ relativePath: "学习/随想.md" }],
    });
    // 删除。
    await call(IPC_CHANNELS.searchRemove, {
      vaultId: "v1",
      relativePath: "学习/随想.md",
    });
    expect(
      await call(IPC_CHANNELS.searchQuery, { vaultId: "v1", query: "索引" }),
    ).toEqual({ ok: true, value: [] });
    // upsert 已消失的文件 → indexed=false。
    expect(
      await call(IPC_CHANNELS.searchUpsert, {
        vaultId: "v1",
        relativePath: "不存在.md",
      }),
    ).toEqual({ ok: true, value: { indexed: false } });
  });

  it("未登记 vaultId → VAULT_NOT_FOUND；schema 拦截链", async () => {
    expect(
      await call(IPC_CHANNELS.searchRebuild, { vaultId: "v-x" }),
    ).toMatchObject({ ok: false, error: { code: "VAULT_NOT_FOUND" } });
    for (const payload of [
      {},
      { vaultId: "v1", limit: 0 },
      { vaultId: "v1", limit: 101 },
    ]) {
      expect(await call(IPC_CHANNELS.searchQuery, payload)).toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT" },
      });
    }
    expect(
      await call(IPC_CHANNELS.searchRemove, {
        vaultId: "v1",
        relativePath: "../x.md",
      }),
    ).toMatchObject({ ok: false, error: { code: "PATH_ESCAPE" } });
  });

  it("transient 仅预览会话允许搜索（只读派生能力）", async () => {
    const transientId = transients.add(vaultRoot, "预览");
    const rebuilt = await call(IPC_CHANNELS.searchRebuild, {
      vaultId: transientId,
    });
    expect(rebuilt.ok).toBe(true);
    expect(
      await call(IPC_CHANNELS.searchQuery, {
        vaultId: transientId,
        query: "组件化",
      }),
    ).toMatchObject({ ok: true, value: [{ pageId: "01S1" }] });
  });
});
