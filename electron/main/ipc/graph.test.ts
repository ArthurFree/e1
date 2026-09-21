// @vitest-environment node
/**
 * R015.1：graph 组 IPC——一次取出 docs/links 后投影，不做 N+1。
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
import { registerGraphHandlers } from "./graph.js";

type Handler = (
  event: unknown,
  payload: unknown,
) => Promise<IpcResult<unknown>>;

let handlers: Map<string, Handler>;

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
  const root = await mkdtemp(join(tmpdir(), "e1-graph-ipc-"));
  const registry = new VaultRegistry(join(root, "recent-vaults.json"));
  const transients = new TransientVaultStore();
  const vaultRoot = await mkdtemp(join(tmpdir(), "e1-graph-vault-"));
  await mkdir(join(vaultRoot, ".e1"));
  await writeFile(
    join(vaultRoot, ".e1", "vault.json"),
    JSON.stringify({
      format: "e1-vault",
      formatVersion: 1,
      vaultId: "v1",
      name: "笔记",
      createdAt: "2026-09-10T00:00:00.000Z",
      assetsDirectory: "assets",
    }),
  );
  await writeFile(
    join(vaultRoot, "甲.md"),
    ["---", "id: 01A", "title: 甲", "---", "", "参见 [乙](乙.md)。", ""].join(
      "\n",
    ),
  );
  await mkdir(join(vaultRoot, "notes"), { recursive: true });
  await writeFile(join(vaultRoot, "乙.md"), "回链 [甲](甲.md)。");
  await writeFile(join(vaultRoot, "notes", "孤岛.md"), "无链接。");
  await registry.touch({
    vaultId: "v1",
    absolutePath: vaultRoot,
    displayName: "笔记",
  });
  registerGraphHandlers(bus, {
    registry,
    transients,
    indexes: new DesktopVaultIndexManager(join(root, "search-index")),
  });
});

describe("graph IPC", () => {
  it("neighborhood 一次返回出站与反向，broken 不虚构节点", async () => {
    const result = await call(IPC_CHANNELS.graphNeighborhood, {
      vaultId: "v1",
      noteKey: "01A",
      depth: 1,
      nodeLimit: 50,
      edgeLimit: 50,
      includeBroken: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as {
      centerNodeId: string;
      nodes: Array<{ id: string }>;
      edges: Array<{ state: string; targetId: string | null }>;
    };
    expect(value.centerNodeId).toBe("01A");
    expect(value.nodes.map((n) => n.id).sort()).toEqual(["01A", "path:乙.md"]);
    expect(value.edges.some((e) => e.targetId === "path:乙.md")).toBe(true);
  });

  it("workspace orphansOnly 只返回孤立文档", async () => {
    const result = await call(IPC_CHANNELS.graphWorkspace, {
      vaultId: "v1",
      nodeLimit: 50,
      edgeLimit: 50,
      filters: { orphansOnly: true, includeBroken: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as {
      nodes: Array<{ id: string; title: string }>;
    };
    expect(
      value.nodes.some(
        (n) => n.title.includes("孤岛") || n.id.includes("孤岛"),
      ),
    ).toBe(true);
    expect(value.nodes.some((n) => n.id === "01A")).toBe(false);
  });

  it("schema 拦截", async () => {
    expect(await call(IPC_CHANNELS.graphNeighborhood, {})).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  });
});
