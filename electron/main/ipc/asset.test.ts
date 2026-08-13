// @vitest-environment node
/**
 * R006-C5：asset 组 IPC handler——pickToken 不泄漏绝对路径、单次消费/
 * 过期/伪造、bytes 与 pick-token 导入、transient 拒写、同名递增。
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  IPC_CHANNELS,
  type IpcResult,
  type ImportedAsset,
  type PickedFile,
} from "../../../shared/ipc/contracts.js";
import {
  CAPABILITY_TOKEN_TTL_MS,
  CapabilityTokenStore,
  type PendingFileSelection,
} from "../CapabilityTokenStore.js";
import { initializeVault } from "../filesystem/VaultFileSystem.js";
import { TransientVaultStore } from "../transientVaults.js";
import { VaultRegistry } from "../vaultRegistry.js";
import type { FileDialogLike } from "./asset.js";
import { registerAssetHandlers } from "./asset.js";
import type { IpcMainLike } from "./handler.js";

type Handler = (
  event: unknown,
  payload: unknown,
) => Promise<IpcResult<unknown>>;

let handlers: Map<string, Handler>;
let registry: VaultRegistry;
let transients: TransientVaultStore;
let vaultRoot: string;
let fileTokens: CapabilityTokenStore<PendingFileSelection>;
let now: number;
let dialogPaths: string[];

const bus: IpcMainLike = {
  handle: (channel, listener) => {
    handlers.set(channel, listener as Handler);
  },
};

const openDialog: FileDialogLike = {
  showOpenDialog: async () => {
    if (dialogPaths.length === 0) return { canceled: true, filePaths: [] };
    return { canceled: false, filePaths: [dialogPaths.shift()!] };
  },
};

function call(channel: string, payload?: unknown): Promise<IpcResult<unknown>> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`handler 未注册：${channel}`);
  return handler({}, payload);
}

beforeEach(async () => {
  handlers = new Map();
  now = 1_000_000;
  dialogPaths = [];
  const stateDir = await mkdtemp(join(tmpdir(), "e1-asset-ipc-state-"));
  registry = new VaultRegistry(join(stateDir, "recent-vaults.json"));
  transients = new TransientVaultStore();
  vaultRoot = await mkdtemp(join(tmpdir(), "e1-asset-ipc-vault-"));
  fileTokens = new CapabilityTokenStore(() => now);
  registerAssetHandlers(bus, {
    registry,
    transients,
    fileTokens,
    openDialog,
  });
});

async function registerVault(): Promise<string> {
  const meta = await initializeVault(vaultRoot, "笔记库");
  await registry.touch({
    vaultId: meta.vaultId,
    absolutePath: vaultRoot,
    displayName: "笔记库",
  });
  return meta.vaultId;
}

describe("asset.pick", () => {
  it("返回 pickToken / 元数据，不含 absolutePath", async () => {
    const srcDir = await mkdtemp(join(tmpdir(), "e1-asset-src-"));
    const src = join(srcDir, "图.png");
    await writeFile(src, Buffer.from([1, 2, 3]));
    dialogPaths.push(src);

    const result = await call(IPC_CHANNELS.assetPick, {
      accept: ["image/png"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const picked = result.value as PickedFile;
    expect(picked.name).toBe("图.png");
    expect(picked.sizeBytes).toBe(3);
    expect(picked.mimeType).toBe("image/png");
    expect(picked.pickToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(picked)).not.toContain(src);
    expect(picked).not.toHaveProperty("absolutePath");
  });

  it("取消 → null", async () => {
    const result = await call(IPC_CHANNELS.assetPick, {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });
});

describe("asset.import", () => {
  it("pick-token：复制进 assets/ 且令牌单次消费", async () => {
    const vaultId = await registerVault();
    const srcDir = await mkdtemp(join(tmpdir(), "e1-asset-src-"));
    const src = join(srcDir, "a.png");
    await writeFile(src, Buffer.from([9, 8]));
    dialogPaths.push(src);
    const pick = await call(IPC_CHANNELS.assetPick, {});
    expect(pick.ok).toBe(true);
    if (!pick.ok) return;
    const token = (pick.value as PickedFile).pickToken;

    const imported = await call(IPC_CHANNELS.assetImport, {
      vaultId,
      fileName: "a.png",
      mimeType: "image/png",
      source: { kind: "pick-token", token },
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const value = imported.value as ImportedAsset;
    expect(value.relativePath).toBe("assets/a.png");
    expect([...(await readFile(join(vaultRoot, "assets", "a.png")))]).toEqual([
      9, 8,
    ]);

    const reuse = await call(IPC_CHANNELS.assetImport, {
      vaultId,
      fileName: "a.png",
      mimeType: "image/png",
      source: { kind: "pick-token", token },
    });
    expect(reuse.ok).toBe(false);
    if (!reuse.ok) expect(reuse.error.code).toBe("SELECTION_INVALID");
  });

  it("bytes 导入与同名递增", async () => {
    const vaultId = await registerVault();
    const first = await call(IPC_CHANNELS.assetImport, {
      vaultId,
      fileName: "a.png",
      mimeType: "image/png",
      source: { kind: "bytes", data: new Uint8Array([1]) },
    });
    const second = await call(IPC_CHANNELS.assetImport, {
      vaultId,
      fileName: "a.png",
      mimeType: "image/png",
      source: { kind: "bytes", data: new Uint8Array([2]) },
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect((first.value as ImportedAsset).relativePath).toBe("assets/a.png");
    expect((second.value as ImportedAsset).relativePath).toBe(
      "assets/a (2).png",
    );
    expect([...(await readFile(join(vaultRoot, "assets", "a.png")))]).toEqual([
      1,
    ]);
    expect([
      ...(await readFile(join(vaultRoot, "assets", "a (2).png"))),
    ]).toEqual([2]);
  });

  it("伪造令牌 → SELECTION_INVALID", async () => {
    const vaultId = await registerVault();
    const result = await call(IPC_CHANNELS.assetImport, {
      vaultId,
      fileName: "a.png",
      mimeType: "image/png",
      source: {
        kind: "pick-token",
        token: "00000000-0000-0000-0000-000000000000",
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SELECTION_INVALID");
  });

  it("过期令牌 → SELECTION_EXPIRED", async () => {
    const vaultId = await registerVault();
    const srcDir = await mkdtemp(join(tmpdir(), "e1-asset-src-"));
    const src = join(srcDir, "a.png");
    await writeFile(src, Buffer.from([1]));
    dialogPaths.push(src);
    const pick = await call(IPC_CHANNELS.assetPick, {});
    expect(pick.ok).toBe(true);
    if (!pick.ok) return;
    now += CAPABILITY_TOKEN_TTL_MS + 1;
    const result = await call(IPC_CHANNELS.assetImport, {
      vaultId,
      fileName: "a.png",
      mimeType: "image/png",
      source: {
        kind: "pick-token",
        token: (pick.value as PickedFile).pickToken,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SELECTION_EXPIRED");
  });

  it("transient Vault → VAULT_READ_ONLY，不创建文件", async () => {
    const plain = await mkdtemp(join(tmpdir(), "e1-plain-"));
    await mkdir(join(plain, "子"), { recursive: true });
    const transientId = transients.add(plain, "预览库");
    const result = await call(IPC_CHANNELS.assetImport, {
      vaultId: transientId,
      fileName: "a.png",
      mimeType: "image/png",
      source: { kind: "bytes", data: new Uint8Array([1]) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VAULT_READ_ONLY");
    await expect(readFile(join(plain, "assets", "a.png"))).rejects.toThrow();
  });
});

describe("asset.read / resolveUrl", () => {
  it("读回导入字节；resolveUrl 为 e1-asset 且不含裸路径", async () => {
    const vaultId = await registerVault();
    const imported = await call(IPC_CHANNELS.assetImport, {
      vaultId,
      fileName: "a.png",
      mimeType: "image/png",
      source: { kind: "bytes", data: new Uint8Array([7, 8, 9]) },
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const assetId = (imported.value as ImportedAsset).assetId;

    const read = await call(IPC_CHANNELS.assetRead, { assetId });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect([...(read.value as { data: Uint8Array }).data]).toEqual([7, 8, 9]);

    const url = await call(IPC_CHANNELS.assetResolveUrl, assetId);
    expect(url.ok).toBe(true);
    if (!url.ok) return;
    expect(url.value).toMatch(/^e1-asset:\/\//);
    expect(String(url.value)).not.toContain(vaultRoot);
  });
});
