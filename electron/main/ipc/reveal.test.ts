// @vitest-environment node
/**
 * R007 阶段 5（§5.2）：note.reveal / asset.reveal IPC handler 测试。
 * 真实 tmp Vault + 真实注册表 + mock shell：
 * 文件/目录定位、目标不存在 → REVEAL_TARGET_NOT_FOUND、transient 允许、
 * 路径逃逸/非法 assetId 拦截、assetId 解码后同一管线。
 */
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, type IpcResult } from "../../../shared/ipc/contracts.js";
import { encodeDesktopAssetId } from "../../../shared/assets/desktopAssetId.js";
import { TransientVaultStore } from "../transientVaults.js";
import { VaultRegistry } from "../vaultRegistry.js";
import type { IpcMainLike } from "./handler.js";
import { createRecordingShell, registerRevealHandlers } from "./reveal.js";

type Handler = (
  event: unknown,
  payload: unknown,
) => Promise<IpcResult<unknown>>;

let handlers: Map<string, Handler>;
let registry: VaultRegistry;
let transients: TransientVaultStore;
let vaultRoot: string;
let showItemInFolder: ReturnType<typeof vi.fn<(fullPath: string) => void>>;

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
  const root = await mkdtemp(join(tmpdir(), "e1-reveal-ipc-"));
  registry = new VaultRegistry(join(root, "recent-vaults.json"));
  transients = new TransientVaultStore();
  vaultRoot = await mkdtemp(join(tmpdir(), "e1-reveal-vault-"));
  await mkdir(join(vaultRoot, "学习"), { recursive: true });
  await mkdir(join(vaultRoot, "assets"), { recursive: true });
  await writeFile(join(vaultRoot, "学习", "React.md"), "# t", "utf8");
  await writeFile(join(vaultRoot, "assets", "pic.png"), "png", "utf8");
  showItemInFolder = vi.fn();
  registerRevealHandlers(bus, {
    registry,
    transients,
    shell: { showItemInFolder },
  });
  await registry.touch({
    vaultId: "v1",
    absolutePath: vaultRoot,
    displayName: "笔记",
  });
});

describe("note.reveal", () => {
  it("定位 .md 文件：PathGuard 解析后调 showItemInFolder", async () => {
    const res = await call(IPC_CHANNELS.noteReveal, {
      vaultId: "v1",
      relativePath: "学习/React.md",
    });
    expect(res).toEqual({ ok: true, value: undefined });
    expect(showItemInFolder).toHaveBeenCalledWith(
      await realpath(join(vaultRoot, "学习", "React.md")),
    );
  });

  it("定位目录（分组）同样允许", async () => {
    const res = await call(IPC_CHANNELS.noteReveal, {
      vaultId: "v1",
      relativePath: "学习",
    });
    expect(res.ok).toBe(true);
    expect(showItemInFolder).toHaveBeenCalledWith(
      await realpath(join(vaultRoot, "学习")),
    );
  });

  it("目标不存在 → REVEAL_TARGET_NOT_FOUND", async () => {
    const res = await call(IPC_CHANNELS.noteReveal, {
      vaultId: "v1",
      relativePath: "学习/不存在.md",
    });
    expect(res).toMatchObject({
      ok: false,
      error: { code: "REVEAL_TARGET_NOT_FOUND" },
    });
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it("未登记 vaultId → VAULT_NOT_FOUND；路径逃逸 → PATH_ESCAPE", async () => {
    expect(
      await call(IPC_CHANNELS.noteReveal, {
        vaultId: "v-x",
        relativePath: "a.md",
      }),
    ).toMatchObject({ ok: false, error: { code: "VAULT_NOT_FOUND" } });
    expect(
      await call(IPC_CHANNELS.noteReveal, {
        vaultId: "v1",
        relativePath: "../etc/passwd",
      }),
    ).toMatchObject({ ok: false, error: { code: "PATH_ESCAPE" } });
    expect(
      await call(IPC_CHANNELS.noteReveal, {
        vaultId: "v1",
        relativePath: "/etc/passwd",
      }),
    ).toMatchObject({ ok: false, error: { code: "PATH_ESCAPE" } });
  });

  it("transient 仅预览会话允许（只读操作）", async () => {
    const transientId = transients.add(vaultRoot, "预览");
    const res = await call(IPC_CHANNELS.noteReveal, {
      vaultId: transientId,
      relativePath: "学习/React.md",
    });
    expect(res.ok).toBe(true);
    expect(showItemInFolder).toHaveBeenCalled();
  });
});

describe("asset.reveal", () => {
  it("assetId 解码后走同一管线（PathGuard → shell）", async () => {
    const assetId = encodeDesktopAssetId("v1", "assets/pic.png");
    const res = await call(IPC_CHANNELS.assetReveal, { assetId });
    expect(res.ok).toBe(true);
    expect(showItemInFolder).toHaveBeenCalledWith(
      await realpath(join(vaultRoot, "assets", "pic.png")),
    );
  });

  it("资源文件不存在 → REVEAL_TARGET_NOT_FOUND；非法 assetId → INVALID_INPUT", async () => {
    const missing = encodeDesktopAssetId("v1", "assets/gone.png");
    expect(
      await call(IPC_CHANNELS.assetReveal, { assetId: missing }),
    ).toMatchObject({ ok: false, error: { code: "REVEAL_TARGET_NOT_FOUND" } });
    for (const payload of [
      { assetId: "not-an-asset-id" },
      { assetId: "" },
      {},
      "x",
    ]) {
      expect(await call(IPC_CHANNELS.assetReveal, payload)).toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT" },
      });
    }
  });

  it("assetId 指向 Vault 外路径在编码层即被拒绝（INVALID_INPUT）", async () => {
    // decodeDesktopAssetId 拒绝含 ".." 的 relativePath。
    const evil = `asset:v1:${encodeURIComponent("v1")}/${encodeURIComponent("../x.md")}`;
    expect(
      await call(IPC_CHANNELS.assetReveal, { assetId: evil }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });
});

describe("createRecordingShell（R009 Stage 0.2，E2E 记录型 stub）", () => {
  it("showItemInFolder 逐行追加到日志文件，不调真实 shell", async () => {
    const dir = await mkdtemp(join(tmpdir(), "e1-reveal-stub-"));
    const logPath = join(dir, "e2e-reveal-stub.log");
    const stub = createRecordingShell(logPath);
    stub.showItemInFolder("/vault/学习/React.md");
    stub.showItemInFolder("/vault/assets/pic.png");
    expect(await readFile(logPath, "utf8")).toBe(
      "/vault/学习/React.md\n/vault/assets/pic.png\n",
    );
  });
});
