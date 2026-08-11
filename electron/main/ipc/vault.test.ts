// @vitest-environment node
/**
 * R006-C2.1：vault 组 IPC handler 授权边界收口测试（FR-01/02/03，§41.1）。
 * 真实 tmp 文件系统 + 真实 VaultRegistry（落盘到 tmp），对话框注入 mock；
 * 验证：selectDirectory 签发一次性令牌且不返回 absolutePath、openSelection
 * 三分流（已初始化/仅预览 transient/初始化并打开）、令牌单次消费与伪造/
 * 过期拒绝、openRecent 正常/未登记/目录不可达/vault.json 消失不重建、
 * scan 双通道（注册表 + transient）、listRecent 透传。
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
import {
  SELECTION_TOKEN_TTL_MS,
  SelectionTokenStore,
} from "../SelectionTokenStore.js";
import { TransientVaultStore } from "../transientVaults.js";
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
let tokens: SelectionTokenStore;
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

async function register(openDialog?: OpenDialogLike): Promise<void> {
  handlers = new Map();
  const dir = await mkdtemp(join(tmpdir(), "e1-ipc-registry-"));
  registry = new VaultRegistry(join(dir, "recent-vaults.json"));
  tokens = new SelectionTokenStore();
  transients = new TransientVaultStore();
  registerVaultHandlers(bus, {
    openDialog: openDialog ?? { showOpenDialog: vi.fn() },
    registry,
    selectionTokens: tokens,
    transients,
  });
}

beforeEach(() => register());

async function makeVaultDir(name: string): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "e1-ipc-vault-"));
  const dir = join(base, name);
  await mkdir(dir);
  return dir;
}

/** 写入合法 .e1/vault.json。 */
async function writeVaultJson(dir: string, vaultId: string): Promise<void> {
  await mkdir(join(dir, ".e1"));
  await writeFile(
    join(dir, ".e1", "vault.json"),
    JSON.stringify({
      format: "e1-vault",
      formatVersion: 1,
      vaultId,
      name: "已初始化",
    }),
  );
}

/** mock 对话框选中 dir 并调用 selectDirectory，返回 SelectedVault。 */
async function selectDir(dir: string): Promise<SelectedVault> {
  await register({
    showOpenDialog: vi
      .fn()
      .mockResolvedValue({ canceled: false, filePaths: [dir] }),
  });
  const result = await call(IPC_CHANNELS.vaultSelectDirectory);
  if (!result.ok) throw new Error("selectDirectory 应成功");
  return result.value as SelectedVault;
}

describe("vault.selectDirectory（FR-01）", () => {
  it("选中已初始化目录 → 真实 vaultId + initialized:true + 令牌；不返回 absolutePath", async () => {
    const dir = await makeVaultDir("已初始化");
    await writeVaultJson(dir, "v-已知");
    const selected = await selectDir(dir);
    expect(selected.vaultId).toBe("v-已知");
    expect(selected.initialized).toBe(true);
    expect(selected.displayName).toBe("已初始化");
    expect(selected.selectionToken).toMatch(/^[0-9a-f-]{36}$/);
    // SEC-01：绝对路径不出现在返回值中。
    expect(selected).not.toHaveProperty("absolutePath");
    expect(JSON.stringify(selected)).not.toContain(dir);
  });

  it("未初始化目录 → vaultId 为 null + initialized:false（不创建任何文件，US-01）", async () => {
    const dir = await makeVaultDir("普通文件夹");
    const selected = await selectDir(dir);
    expect(selected.vaultId).toBeNull();
    expect(selected.initialized).toBe(false);
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(dir)).toEqual([]);
  });

  it("取消选择 → ok(null)，不签发令牌", async () => {
    await register({
      showOpenDialog: vi
        .fn()
        .mockResolvedValue({ canceled: true, filePaths: [] }),
    });
    const result = await call(IPC_CHANNELS.vaultSelectDirectory);
    expect(result).toEqual({ ok: true, value: null });
  });
});

describe("vault.openSelection（FR-01/FR-03）", () => {
  it("已初始化目录：直接打开并登记最近列表（initialized:false）", async () => {
    const dir = await makeVaultDir("已初始化");
    await writeVaultJson(dir, "v-已知");
    const selected = await selectDir(dir);
    const result = await call(IPC_CHANNELS.vaultOpenSelection, {
      selectionToken: selected.selectionToken,
      initialize: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const opened = result.value as OpenedVault;
    expect(opened).toMatchObject({
      vaultId: "v-已知",
      absolutePath: dir,
      name: "已初始化",
      displayName: "已初始化",
      initialized: false,
    });
    expect(opened.transient).toBeUndefined();
    const recent = await registry.list();
    expect(recent).toHaveLength(1);
    expect(recent[0].vaultId).toBe("v-已知");
  });

  it("未初始化 + initialize=false：transient 仅预览会话（不写文件、不进注册表）", async () => {
    const dir = await makeVaultDir("普通文件夹");
    const selected = await selectDir(dir);
    const result = await call(IPC_CHANNELS.vaultOpenSelection, {
      selectionToken: selected.selectionToken,
      initialize: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const opened = result.value as OpenedVault;
    expect(opened.vaultId).toMatch(/^transient:[0-9a-f-]{36}$/);
    expect(opened).toMatchObject({
      absolutePath: dir,
      name: "普通文件夹",
      displayName: "普通文件夹",
      initialized: false,
      transient: true,
    });
    // 不写任何文件（US-01），不进最近列表。
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(dir)).toEqual([]);
    expect(await registry.list()).toEqual([]);
  });

  it("未初始化 + initialize=true：初始化（vault.json + assets/）并登记最近列表", async () => {
    const dir = await makeVaultDir("新库");
    const selected = await selectDir(dir);
    const result = await call(IPC_CHANNELS.vaultOpenSelection, {
      selectionToken: selected.selectionToken,
      initialize: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const opened = result.value as OpenedVault;
    expect(opened.initialized).toBe(true);
    expect(opened.vaultId).toMatch(/^[0-9a-f-]{36}$/);
    const { readFile, stat } = await import("node:fs/promises");
    const meta = JSON.parse(
      await readFile(join(dir, ".e1", "vault.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(meta.vaultId).toBe(opened.vaultId);
    expect((await stat(join(dir, "assets"))).isDirectory()).toBe(true);
    expect(await registry.list()).toHaveLength(1);
  });

  it("令牌单次消费：第二次使用 → SELECTION_INVALID", async () => {
    const dir = await makeVaultDir("单次");
    await writeVaultJson(dir, "v-单次");
    const selected = await selectDir(dir);
    const first = await call(IPC_CHANNELS.vaultOpenSelection, {
      selectionToken: selected.selectionToken,
      initialize: false,
    });
    expect(first.ok).toBe(true);
    const second = await call(IPC_CHANNELS.vaultOpenSelection, {
      selectionToken: selected.selectionToken,
      initialize: false,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("SELECTION_INVALID");
  });

  it("伪造令牌 → SELECTION_INVALID；过期令牌 → SELECTION_EXPIRED", async () => {
    await register();
    const forged = await call(IPC_CHANNELS.vaultOpenSelection, {
      selectionToken: "00000000-0000-0000-0000-000000000000",
      initialize: false,
    });
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.error.code).toBe("SELECTION_INVALID");

    // 注入时钟的令牌存储：签发后拨快 5 分钟以上。
    let now = 1_000_000;
    handlers = new Map();
    const dir = await mkdtemp(join(tmpdir(), "e1-ipc-registry-"));
    registry = new VaultRegistry(join(dir, "recent-vaults.json"));
    tokens = new SelectionTokenStore(() => now);
    registerVaultHandlers(bus, {
      openDialog: { showOpenDialog: vi.fn() },
      registry,
      selectionTokens: tokens,
      transients,
    });
    const token = tokens.issue(join(tmpdir(), "任意目录"));
    now += SELECTION_TOKEN_TTL_MS + 1;
    const expired = await call(IPC_CHANNELS.vaultOpenSelection, {
      selectionToken: token,
      initialize: false,
    });
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.error.code).toBe("SELECTION_EXPIRED");
  });

  it("vault.json 损坏 → INVALID_INPUT，且不修改文件（SEC-07 不自动修复）", async () => {
    const dir = await makeVaultDir("坏库");
    await mkdir(join(dir, ".e1"));
    await writeFile(join(dir, ".e1", "vault.json"), "{ 坏");
    const selected = await selectDir(dir);
    // 损坏不阻断目录选择（按未初始化返回）。
    expect(selected.vaultId).toBeNull();
    const result = await call(IPC_CHANNELS.vaultOpenSelection, {
      selectionToken: selected.selectionToken,
      initialize: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
  });

  it("入参形状非法 → INVALID_INPUT", async () => {
    await register();
    const missing = await call(IPC_CHANNELS.vaultOpenSelection, {
      initialize: true,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("INVALID_INPUT");
    const badBool = await call(IPC_CHANNELS.vaultOpenSelection, {
      selectionToken: "t",
      initialize: "yes",
    });
    expect(badBool.ok).toBe(false);
    if (!badBool.ok) expect(badBool.error.code).toBe("INVALID_INPUT");
  });
});

describe("vault.openRecent（FR-02）", () => {
  it("已登记 vaultId：解析根目录打开并刷新最近列表", async () => {
    const dir = await makeVaultDir("最近库");
    await writeVaultJson(dir, "v-最近");
    await registry.touch({
      vaultId: "v-最近",
      absolutePath: dir,
      displayName: "最近库",
    });
    const result = await call(IPC_CHANNELS.vaultOpenRecent, {
      vaultId: "v-最近",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value as OpenedVault).toMatchObject({
      vaultId: "v-最近",
      absolutePath: dir,
      displayName: "最近库",
      initialized: false,
    });
  });

  it("未登记 vaultId → VAULT_NOT_FOUND", async () => {
    await register();
    const result = await call(IPC_CHANNELS.vaultOpenRecent, {
      vaultId: "v-未登记",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VAULT_NOT_FOUND");
  });

  it("目录不可达 → VAULT_NOT_FOUND", async () => {
    const dir = await makeVaultDir("将移走");
    await writeVaultJson(dir, "v-移走");
    await registry.touch({
      vaultId: "v-移走",
      absolutePath: dir,
      displayName: "将移走",
    });
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
    const result = await call(IPC_CHANNELS.vaultOpenRecent, {
      vaultId: "v-移走",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VAULT_NOT_FOUND");
  });

  it("vault.json 消失 → VAULT_NOT_FOUND，不自动重建（SEC-07）", async () => {
    const dir = await makeVaultDir("丢元数据");
    await writeVaultJson(dir, "v-丢");
    await registry.touch({
      vaultId: "v-丢",
      absolutePath: dir,
      displayName: "丢元数据",
    });
    const { rm, readdir } = await import("node:fs/promises");
    await rm(join(dir, ".e1"), { recursive: true, force: true });
    const result = await call(IPC_CHANNELS.vaultOpenRecent, {
      vaultId: "v-丢",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VAULT_NOT_FOUND");
    // 不重建 .e1。
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("vault.scan 双通道（注册表 + transient）", () => {
  it("未登记的 vaultId → VAULT_NOT_FOUND", async () => {
    const result = await call(IPC_CHANNELS.vaultScan, "v-未登记");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VAULT_NOT_FOUND");
  });

  it("注册表通道：openRecent 后 scan 返回页面树", async () => {
    const dir = await makeVaultDir("扫描库");
    await mkdir(join(dir, "学习"));
    await writeFile(
      join(dir, "学习", "React.md"),
      "---\nid: n1\ntitle: React\n---\n\n正文\n",
    );
    await writeFile(join(dir, "README.md"), "# 说明\n");
    await writeVaultJson(dir, "v-扫描");
    await registry.touch({
      vaultId: "v-扫描",
      absolutePath: dir,
      displayName: "扫描库",
    });

    const result = await call(IPC_CHANNELS.vaultScan, "v-扫描");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scan = result.value as VaultScanResult;
    expect(scan.vault.vaultId).toBe("v-扫描");
    expect(scan.entries.map((e) => e.relativePath).sort()).toEqual([
      "README.md",
      "学习",
      "学习/React.md",
    ]);
    expect(scan.entries.find((e) => e.noteId === "n1")?.title).toBe("React");
  });

  it("transient 通道：仅预览会话可扫描（不写任何文件）", async () => {
    const dir = await makeVaultDir("预览库");
    await writeFile(join(dir, "笔记.md"), "# 笔记\n");
    const selected = await selectDir(dir);
    const opened = await call(IPC_CHANNELS.vaultOpenSelection, {
      selectionToken: selected.selectionToken,
      initialize: false,
    });
    if (!opened.ok) throw new Error("openSelection 应成功");
    const { vaultId } = opened.value as OpenedVault;

    const result = await call(IPC_CHANNELS.vaultScan, vaultId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scan = result.value as VaultScanResult;
    expect(scan.entries.map((e) => e.relativePath)).toEqual(["笔记.md"]);
    // 仍不产生 .e1。
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(dir)).toEqual(["笔记.md"]);
  });

  it("登记后目录被移走 → VAULT_NOT_FOUND", async () => {
    const dir = await makeVaultDir("将移走");
    await writeVaultJson(dir, "v-移走");
    await registry.touch({
      vaultId: "v-移走",
      absolutePath: dir,
      displayName: "将移走",
    });
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
    const result = await call(IPC_CHANNELS.vaultScan, "v-移走");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VAULT_NOT_FOUND");
  });
});

describe("vault.listRecent", () => {
  it("空表 → ok([])；openRecent 后含登记条目", async () => {
    const empty = await call(IPC_CHANNELS.vaultListRecent);
    expect(empty).toEqual({ ok: true, value: [] });

    const dir = await makeVaultDir("最近库");
    await writeVaultJson(dir, "v-最近");
    await registry.touch({
      vaultId: "v-最近",
      absolutePath: dir,
      displayName: "最近库",
    });
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
