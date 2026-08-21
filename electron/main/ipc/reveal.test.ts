// @vitest-environment node
/**
 * R008 Stage 2（§9，R8-07）：reveal 组 IPC handler 测试。
 * 真实 tmp 文件系统 + 真实 VaultRegistry/TransientVaultStore + mock shell：
 * - note.reveal / asset.reveal 正常定位（文件与目录），shell 收到 realpath
 *   后的 Vault 内绝对路径；
 * - 目标不存在 → NOTE_NOT_FOUND（复用现有码，不新增 REVEAL_*）；
 * - schema 拦截链（非对象 / 绝对路径 / ".." / 空段）；
 * - symlink 逃逸 → PATH_ESCAPE；未登记 vaultId → VAULT_NOT_FOUND；
 * - transient 仅预览 Vault 允许 reveal（只读操作，§9.5）；
 * - shell 缺失 → INTERNAL。
 */
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, type IpcResult } from "../../../shared/ipc/contracts.js";
import { TransientVaultStore } from "../transientVaults.js";
import { VaultRegistry } from "../vaultRegistry.js";
import type { IpcMainLike } from "./handler.js";
import { registerRevealHandlers, type ShellLike } from "./reveal.js";

// reveal.ts 顶层 import electron.shell；测试经 deps.shell 注入 mock，
// 这里只保证模块可加载（缺省 shell 分支另有覆盖）。
vi.mock("electron", () => ({
  shell: { showItemInFolder: vi.fn() },
}));

type Handler = (
  event: unknown,
  payload: unknown,
) => Promise<IpcResult<unknown>>;

let handlers: Map<string, Handler>;
let registry: VaultRegistry;
let transients: TransientVaultStore;
let vaultRoot: string;
let shellMock: { showItemInFolder: ReturnType<typeof vi.fn> };

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

/** 以注入的 shellMock 注册 handler（缺省分支测试单独注册）。 */
function register(deps: { shell?: ShellLike } = {}) {
  handlers = new Map();
  registerRevealHandlers(bus, {
    registry,
    transients,
    shell: deps.shell ?? (shellMock as ShellLike),
  });
}

/** 登记 vaultRoot 为常规 Vault（vaultId = "v-reveal"）。 */
async function registerVault(): Promise<string> {
  await registry.touch({
    vaultId: "v-reveal",
    absolutePath: vaultRoot,
    displayName: "定位库",
  });
  return "v-reveal";
}

/** shell 收到的路径应等于 realpath 后的 Vault 内绝对路径（macOS /tmp → /private/tmp）。 */
async function expectedAbs(relativePath: string): Promise<string> {
  return join(await realpath(vaultRoot), ...relativePath.split("/"));
}

beforeEach(async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "e1-reveal-ipc-state-"));
  registry = new VaultRegistry(join(stateDir, "recent-vaults.json"));
  transients = new TransientVaultStore();
  vaultRoot = await mkdtemp(join(tmpdir(), "e1-reveal-ipc-vault-"));
  shellMock = { showItemInFolder: vi.fn() };
  register();
});

describe("note.reveal / asset.reveal 正常定位", () => {
  it("note.reveal：文件存在 → shell.showItemInFolder 收到根内绝对路径，返回 null", async () => {
    const vaultId = await registerVault();
    await writeFile(join(vaultRoot, "笔记.md"), "# 笔记\n", "utf8");

    const res = await call(IPC_CHANNELS.noteReveal, {
      vaultId,
      relativePath: "笔记.md",
    });
    expect(res).toEqual({ ok: true, value: null });
    expect(shellMock.showItemInFolder).toHaveBeenCalledTimes(1);
    expect(shellMock.showItemInFolder).toHaveBeenCalledWith(
      await expectedAbs("笔记.md"),
    );
  });

  it("asset.reveal：嵌套附件路径 → 同一安全链路", async () => {
    const vaultId = await registerVault();
    await mkdir(join(vaultRoot, "assets"), { recursive: true });
    await writeFile(join(vaultRoot, "assets", "design.pdf"), "%PDF", "utf8");

    const res = await call(IPC_CHANNELS.assetReveal, {
      vaultId,
      relativePath: "assets/design.pdf",
    });
    expect(res).toEqual({ ok: true, value: null });
    expect(shellMock.showItemInFolder).toHaveBeenCalledWith(
      await expectedAbs("assets/design.pdf"),
    );
  });

  it("目录同样允许 reveal（showItemInFolder 选中该目录）", async () => {
    const vaultId = await registerVault();
    await mkdir(join(vaultRoot, "学习"), { recursive: true });

    const res = await call(IPC_CHANNELS.noteReveal, {
      vaultId,
      relativePath: "学习",
    });
    expect(res).toEqual({ ok: true, value: null });
    expect(shellMock.showItemInFolder).toHaveBeenCalledWith(
      await expectedAbs("学习"),
    );
  });

  it("transient 仅预览 Vault 允许 reveal（只读操作，§9.5）", async () => {
    const transientId = transients.add(vaultRoot, "预览库");
    await writeFile(join(vaultRoot, "普通.md"), "# 普通\n", "utf8");

    const res = await call(IPC_CHANNELS.noteReveal, {
      vaultId: transientId,
      relativePath: "普通.md",
    });
    expect(res).toEqual({ ok: true, value: null });
    expect(shellMock.showItemInFolder).toHaveBeenCalledWith(
      await expectedAbs("普通.md"),
    );
  });
});

describe("reveal 安全链路", () => {
  it("目标不存在 → NOTE_NOT_FOUND", async () => {
    const vaultId = await registerVault();
    const res = await call(IPC_CHANNELS.noteReveal, {
      vaultId,
      relativePath: "不存在.md",
    });
    expect(res).toMatchObject({ ok: false, error: { code: "NOTE_NOT_FOUND" } });
    expect(shellMock.showItemInFolder).not.toHaveBeenCalled();
  });

  it("未登记 vaultId → VAULT_NOT_FOUND", async () => {
    const res = await call(IPC_CHANNELS.noteReveal, {
      vaultId: "v-未登记",
      relativePath: "a.md",
    });
    expect(res).toMatchObject({
      ok: false,
      error: { code: "VAULT_NOT_FOUND" },
    });
  });

  it("symlink 逃逸出 Vault → PATH_ESCAPE", async () => {
    const vaultId = await registerVault();
    const outside = await mkdtemp(join(tmpdir(), "e1-reveal-outside-"));
    await writeFile(join(outside, "secret.md"), "# 外部\n", "utf8");
    await symlink(
      join(outside, "secret.md"),
      join(vaultRoot, "链接.md"),
      "file",
    );

    const res = await call(IPC_CHANNELS.noteReveal, {
      vaultId,
      relativePath: "链接.md",
    });
    expect(res).toMatchObject({ ok: false, error: { code: "PATH_ESCAPE" } });
    expect(shellMock.showItemInFolder).not.toHaveBeenCalled();
  });

  it("schema 拦截链：非对象入参 → INVALID_INPUT", async () => {
    for (const payload of [undefined, null, 42, "笔记.md", []]) {
      const res = await call(IPC_CHANNELS.noteReveal, payload);
      expect(res, `payload=${String(payload)}`).toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT" },
      });
    }
  });

  it("schema 拦截链：绝对路径/盘符/../逃逸/空段 → PATH_ESCAPE", async () => {
    const vaultId = await registerVault();
    for (const relativePath of [
      "/etc/passwd",
      "C:\\Windows\\system.ini",
      "../outside.md",
      "学习/../../outside.md",
      "学习//笔记.md",
      "学习/./笔记.md",
    ]) {
      const res = await call(IPC_CHANNELS.noteReveal, {
        vaultId,
        relativePath,
      });
      expect(res, `relativePath=${relativePath}`).toMatchObject({
        ok: false,
        error: { code: "PATH_ESCAPE" },
      });
    }
    expect(shellMock.showItemInFolder).not.toHaveBeenCalled();
  });

  it("schema 拦截链：空 relativePath / 空 vaultId → INVALID_INPUT", async () => {
    const vaultId = await registerVault();
    const emptyPath = await call(IPC_CHANNELS.noteReveal, {
      vaultId,
      relativePath: "  ",
    });
    expect(emptyPath).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    const emptyVault = await call(IPC_CHANNELS.assetReveal, {
      vaultId: "",
      relativePath: "assets/a.png",
    });
    expect(emptyVault).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  });

  it("shell 缺失/无 showItemInFolder（非 Electron 环境）→ INTERNAL，不解析路径也不 crash", async () => {
    const vaultId = await registerVault();
    await writeFile(join(vaultRoot, "笔记.md"), "# 笔记\n", "utf8");
    handlers = new Map();
    registerRevealHandlers(bus, {
      registry,
      transients,
      shell: {} as ShellLike,
    });

    const res = await call(IPC_CHANNELS.noteReveal, {
      vaultId,
      relativePath: "笔记.md",
    });
    expect(res).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
  });
});
