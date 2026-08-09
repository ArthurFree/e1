// @vitest-environment node
/**
 * R006 阶段 2：vault 组 IPC handler 真实实现测试。
 * 真实 tmp 文件系统 + 真实 VaultRegistry（落盘到 tmp），对话框注入 mock；
 * 验证：selectDirectory 读取 vaultId、open 初始化/幂等/登记最近列表/
 * 错误归一（VAULT_NOT_FOUND/INVALID_INPUT）、scan 经 vaultId 解析根目录、
 * listRecent 透传。
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  IPC_CHANNELS,
  type IpcResult,
  type OpenedVault,
  type RecentVault,
  type SelectedVault,
  type VaultScanResult,
} from "../../../shared/ipc/contracts.js";
import { VaultRegistry } from "../vaultRegistry.js";
import { registerVaultHandlers, type OpenDialogLike } from "./vault.js";
import type { IpcMainLike } from "./handler.js";

vi.mock("electron", () => ({
  dialog: { showOpenDialog: vi.fn() },
}));

type Handler = (
  event: unknown,
  payload: unknown,
) => Promise<IpcResult<unknown>>;

let handlers: Map<string, Handler>;
let registry: VaultRegistry;

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

async function register(openDialog?: OpenDialogLike): Promise<void> {
  handlers = new Map();
  const dir = await mkdtemp(join(tmpdir(), "e1-ipc-registry-"));
  registry = new VaultRegistry(join(dir, "recent-vaults.json"));
  registerVaultHandlers(bus, {
    openDialog: openDialog ?? { showOpenDialog: vi.fn() },
    registry,
  });
}

beforeEach(() => register());

async function makeVaultDir(name: string): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "e1-ipc-vault-"));
  const dir = join(base, name);
  await mkdir(dir);
  return dir;
}

describe("vault.selectDirectory", () => {
  it("选中的目录已是 Vault → 返回真实 vaultId", async () => {
    const dir = await makeVaultDir("已初始化");
    await mkdir(join(dir, ".e1"));
    await writeFile(
      join(dir, ".e1", "vault.json"),
      JSON.stringify({
        format: "e1-vault",
        formatVersion: 1,
        vaultId: "v-已知",
        name: "已初始化",
      }),
    );
    await register({
      showOpenDialog: vi
        .fn()
        .mockResolvedValue({ canceled: false, filePaths: [dir] }),
    });
    const result = await call(IPC_CHANNELS.vaultSelectDirectory);
    expect(result).toEqual({
      ok: true,
      value: {
        vaultId: "v-已知",
        absolutePath: dir,
        displayName: "已初始化",
      } satisfies SelectedVault,
    });
  });

  it("未初始化目录 → vaultId 为 null（不创建任何文件，US-01）", async () => {
    const dir = await makeVaultDir("普通文件夹");
    await register({
      showOpenDialog: vi
        .fn()
        .mockResolvedValue({ canceled: false, filePaths: [dir] }),
    });
    const result = await call(IPC_CHANNELS.vaultSelectDirectory);
    expect(result.ok && (result.value as SelectedVault).vaultId).toBeNull();
    // .e1 未被创建。
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("vault.open", () => {
  it("未初始化目录 → 初始化（initialized: true）并登记最近列表", async () => {
    const dir = await makeVaultDir("新库");
    const result = await call(IPC_CHANNELS.vaultOpen, {
      absolutePath: dir,
      name: "我的库",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const opened = result.value as OpenedVault;
    expect(opened).toMatchObject({
      absolutePath: dir,
      name: "我的库",
      displayName: "新库",
      initialized: true,
    });
    expect(opened.vaultId).toMatch(/^[0-9a-f-]{36}$/);
    // 落盘：.e1/vault.json 与 assets/。
    const { readFile, stat } = await import("node:fs/promises");
    const meta = JSON.parse(
      await readFile(join(dir, ".e1", "vault.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(meta.vaultId).toBe(opened.vaultId);
    expect((await stat(join(dir, "assets"))).isDirectory()).toBe(true);
    // 已登记最近列表。
    const recent = await registry.list();
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      vaultId: opened.vaultId,
      accessible: true,
    });
  });

  it("已初始化目录 → 幂等打开（initialized: false，vaultId 不变）", async () => {
    const dir = await makeVaultDir("库");
    const first = await call(IPC_CHANNELS.vaultOpen, { absolutePath: dir });
    const second = await call(IPC_CHANNELS.vaultOpen, {
      absolutePath: dir,
      name: "改名无效",
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect((second.value as OpenedVault).initialized).toBe(false);
    expect((second.value as OpenedVault).vaultId).toBe(
      (first.value as OpenedVault).vaultId,
    );
    expect((second.value as OpenedVault).name).not.toBe("改名无效");
  });

  it("相对路径 → INVALID_INPUT；不存在目录 → VAULT_NOT_FOUND", async () => {
    const relative = await call(IPC_CHANNELS.vaultOpen, {
      absolutePath: "some/relative",
    });
    expect(relative.ok).toBe(false);
    if (!relative.ok) expect(relative.error.code).toBe("INVALID_INPUT");

    const missing = await call(IPC_CHANNELS.vaultOpen, {
      absolutePath: join(tmpdir(), "e1-不存在-xyz"),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("VAULT_NOT_FOUND");
  });

  it("vault.json 损坏 → INVALID_INPUT，且不修改文件", async () => {
    const dir = await makeVaultDir("坏库");
    await mkdir(join(dir, ".e1"));
    await writeFile(join(dir, ".e1", "vault.json"), "{ 坏");
    const result = await call(IPC_CHANNELS.vaultOpen, { absolutePath: dir });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
  });
});

describe("vault.scan", () => {
  it("未登记的 vaultId → VAULT_NOT_FOUND", async () => {
    const result = await call(IPC_CHANNELS.vaultScan, "v-未登记");
    expect(result).toEqual({
      ok: false,
      error: {
        code: "VAULT_NOT_FOUND",
        message: expect.stringContaining("未登记"),
      },
    });
  });

  it("open 后 scan：经注册表解析根目录返回页面树", async () => {
    const dir = await makeVaultDir("扫描库");
    await mkdir(join(dir, "学习"));
    await writeFile(
      join(dir, "学习", "React.md"),
      "---\nid: n1\ntitle: React\n---\n\n正文\n",
    );
    await writeFile(join(dir, "README.md"), "# 说明\n");

    const opened = await call(IPC_CHANNELS.vaultOpen, { absolutePath: dir });
    if (!opened.ok) throw new Error("open 应成功");
    const { vaultId } = opened.value as OpenedVault;

    const result = await call(IPC_CHANNELS.vaultScan, vaultId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scan = result.value as VaultScanResult;
    expect(scan.vault.vaultId).toBe(vaultId);
    expect(scan.entries.map((e) => e.relativePath).sort()).toEqual([
      "README.md",
      "学习",
      "学习/React.md",
    ]);
    expect(scan.entries.find((e) => e.noteId === "n1")?.title).toBe("React");
  });

  it("登记后目录被移走 → VAULT_NOT_FOUND", async () => {
    const dir = await makeVaultDir("将移走");
    const opened = await call(IPC_CHANNELS.vaultOpen, { absolutePath: dir });
    if (!opened.ok) throw new Error("open 应成功");
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
    const result = await call(
      IPC_CHANNELS.vaultScan,
      (opened.value as OpenedVault).vaultId,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VAULT_NOT_FOUND");
  });
});

describe("vault.listRecent", () => {
  it("空表 → ok([])；open 后含登记条目", async () => {
    const empty = await call(IPC_CHANNELS.vaultListRecent);
    expect(empty).toEqual({ ok: true, value: [] });

    const dir = await makeVaultDir("最近库");
    await call(IPC_CHANNELS.vaultOpen, { absolutePath: dir });
    const result = await call(IPC_CHANNELS.vaultListRecent);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const recent = result.value as RecentVault[];
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      absolutePath: dir,
      displayName: "最近库",
      accessible: true,
    });
  });

  it("携带负载 → INVALID_INPUT", async () => {
    const result = await call(IPC_CHANNELS.vaultListRecent, { x: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
  });
});
