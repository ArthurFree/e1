// @vitest-environment node
/**
 * R007 阶段 4（文件操作闭环）：files 组 IPC handler 测试。
 * 真实 tmp 文件系统 + 真实 VaultRegistry/TransientVaultStore/
 * SelfWriteRegistry（依赖注入）：信封形状、transient 拒写（VAULT_READ_ONLY）、
 * 保留区/冲突错误码透传、自写登记点（trash 源路径 / restore 目标路径 /
 * move·renameFile 旧+新路径）、listTrash 只读豁免。
 */
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  IPC_CHANNELS,
  type CreateDirectoryResult,
  type IpcResult,
  type MoveNoteResult,
  type PurgeTrashResult,
  type RenameNoteFileResult,
  type RestoreTrashResult,
  type TrashListResult,
  type TrashResult,
} from "../../../shared/ipc/contracts.js";
import { TransientVaultStore } from "../transientVaults.js";
import { VaultRegistry } from "../vaultRegistry.js";
import { SelfWriteRegistry } from "../watcher/SelfWriteRegistry.js";
import type { IpcMainLike } from "./handler.js";
import { registerFileHandlers } from "./files.js";

type Handler = (
  event: unknown,
  payload: unknown,
) => Promise<IpcResult<unknown>>;

let handlers: Map<string, Handler>;
let registry: VaultRegistry;
let transients: TransientVaultStore;
let selfWrites: SelfWriteRegistry;
let vaultRoot: string;

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
  const stateDir = await mkdtemp(join(tmpdir(), "e1-files-ipc-state-"));
  registry = new VaultRegistry(join(stateDir, "recent-vaults.json"));
  transients = new TransientVaultStore();
  selfWrites = new SelfWriteRegistry();
  vaultRoot = await mkdtemp(join(tmpdir(), "e1-files-ipc-vault-"));
  registerFileHandlers(bus, { registry, transients, selfWrites });
});

/** 登记 vaultRoot 为常规 Vault（vaultId = "v-文件"）。 */
async function registerVault(): Promise<string> {
  await registry.touch({
    vaultId: "v-文件",
    absolutePath: vaultRoot,
    displayName: "文件库",
  });
  return "v-文件";
}

async function exists(relativePath: string): Promise<boolean> {
  try {
    await stat(join(vaultRoot, ...relativePath.split("/")));
    return true;
  } catch {
    return false;
  }
}

describe("vault.createDirectory", () => {
  it("成功创建目录（信封 ok + relativePath）", async () => {
    const vaultId = await registerVault();
    const result = await call(IPC_CHANNELS.vaultCreateDirectory, {
      vaultId,
      parentRelativePath: "",
      name: "学习",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value as CreateDirectoryResult).relativePath).toBe("学习");
    expect(await exists("学习")).toBe(true);
  });

  it("保留名 → VAULT_RESERVED_PATH；transient → VAULT_READ_ONLY", async () => {
    const vaultId = await registerVault();
    const reserved = await call(IPC_CHANNELS.vaultCreateDirectory, {
      vaultId,
      parentRelativePath: "",
      name: "assets",
    });
    expect(reserved.ok).toBe(false);
    if (!reserved.ok) expect(reserved.error.code).toBe("VAULT_RESERVED_PATH");

    const transientId = transients.add(vaultRoot, "预览库");
    const readOnly = await call(IPC_CHANNELS.vaultCreateDirectory, {
      vaultId: transientId,
      parentRelativePath: "",
      name: "x",
    });
    expect(readOnly.ok).toBe(false);
    if (!readOnly.ok) expect(readOnly.error.code).toBe("VAULT_READ_ONLY");
  });

  it("schema 拦截：name 含分隔符 → INVALID_INPUT", async () => {
    const vaultId = await registerVault();
    const result = await call(IPC_CHANNELS.vaultCreateDirectory, {
      vaultId,
      parentRelativePath: "",
      name: "a/b",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
  });
});

describe("vault.trash / listTrash / restore / purgeTrash 闭环", () => {
  it("删除 → 列表 → 恢复 → 永久删除全链路；自写登记点正确", async () => {
    const vaultId = await registerVault();
    await mkdir(join(vaultRoot, "学习"));
    await writeFile(
      join(vaultRoot, "学习", "React.md"),
      "---\nid: n-1\n---\n\n# React\n",
      "utf8",
    );

    const trashed = await call(IPC_CHANNELS.vaultTrash, {
      vaultId,
      relativePath: "学习/React.md",
    });
    expect(trashed.ok).toBe(true);
    if (!trashed.ok) return;
    const { operationId } = trashed.value as TrashResult;
    expect(await exists("学习/React.md")).toBe(false);
    // 自写登记：源路径（无 token，路径+TTL 抑制 unlink 回声）。
    expect(selfWrites.shouldSuppress(vaultId, "学习/React.md", null)).toBe(
      true,
    );

    const listed = await call(IPC_CHANNELS.vaultListTrash, { vaultId });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const { entries } = listed.value as TrashListResult;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      operationId,
      originalRelativePath: "学习/React.md",
      stableNoteId: "n-1",
    });

    const restored = await call(IPC_CHANNELS.vaultRestore, {
      vaultId,
      operationId,
    });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect((restored.value as RestoreTrashResult).relativePath).toBe(
      "学习/React.md",
    );
    expect(await exists("学习/React.md")).toBe(true);
    // 自写登记：恢复目标路径。
    expect(selfWrites.shouldSuppress(vaultId, "学习/React.md", null)).toBe(
      true,
    );

    // 再次删除后永久删除。
    const trashedAgain = await call(IPC_CHANNELS.vaultTrash, {
      vaultId,
      relativePath: "学习/React.md",
    });
    expect(trashedAgain.ok).toBe(true);
    if (!trashedAgain.ok) return;
    const purged = await call(IPC_CHANNELS.vaultPurgeTrash, {
      vaultId,
      operationId: (trashedAgain.value as TrashResult).operationId,
    });
    expect(purged.ok).toBe(true);
    if (!purged.ok) return;
    expect((purged.value as PurgeTrashResult).purged).toBe(1);
    const listedAfter = await call(IPC_CHANNELS.vaultListTrash, { vaultId });
    expect(listedAfter.ok).toBe(true);
    if (!listedAfter.ok) return;
    expect((listedAfter.value as TrashListResult).entries).toEqual([]);
  });

  it("restore 不存在的 operationId → VAULT_TRASH_NOT_FOUND", async () => {
    const vaultId = await registerVault();
    const result = await call(IPC_CHANNELS.vaultRestore, {
      vaultId,
      operationId: "mabc-000000000000",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VAULT_TRASH_NOT_FOUND");
  });

  it("transient：trash/restore/purge 拒写，listTrash 只读豁免返回空表", async () => {
    const transientId = transients.add(vaultRoot, "预览库");
    await writeFile(join(vaultRoot, "a.md"), "# a\n", "utf8");

    for (const [channel, payload] of [
      [IPC_CHANNELS.vaultTrash, { vaultId: transientId, relativePath: "a.md" }],
      [
        IPC_CHANNELS.vaultRestore,
        { vaultId: transientId, operationId: "mabc-000000000000" },
      ],
      [IPC_CHANNELS.vaultPurgeTrash, { vaultId: transientId }],
    ] as const) {
      const result = await call(channel, payload);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("VAULT_READ_ONLY");
    }

    const listed = await call(IPC_CHANNELS.vaultListTrash, {
      vaultId: transientId,
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect((listed.value as TrashListResult).entries).toEqual([]);
    // 预览会话未产生任何文件变化。
    expect(await exists("a.md")).toBe(true);
  });
});

describe("note.move / note.renameFile", () => {
  it("move 成功：新路径返回 + 旧、新路径各登记一次自写", async () => {
    const vaultId = await registerVault();
    await mkdir(join(vaultRoot, "学习"));
    await writeFile(join(vaultRoot, "React.md"), "# React\n", "utf8");

    const result = await call(IPC_CHANNELS.noteMove, {
      vaultId,
      relativePath: "React.md",
      targetDirectory: "学习",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value as MoveNoteResult).relativePath).toBe("学习/React.md");
    expect(await exists("React.md")).toBe(false);
    expect(await exists("学习/React.md")).toBe(true);
    expect(selfWrites.shouldSuppress(vaultId, "React.md", null)).toBe(true);
    expect(selfWrites.shouldSuppress(vaultId, "学习/React.md", null)).toBe(
      true,
    );
  });

  it("move 冲突 → VAULT_PATH_COLLISION；目标保留区 → VAULT_RESERVED_PATH", async () => {
    const vaultId = await registerVault();
    await mkdir(join(vaultRoot, "学习"));
    await mkdir(join(vaultRoot, "assets"));
    await writeFile(join(vaultRoot, "a.md"), "# 源\n", "utf8");
    await writeFile(join(vaultRoot, "学习", "a.md"), "# 目标\n", "utf8");

    const collision = await call(IPC_CHANNELS.noteMove, {
      vaultId,
      relativePath: "a.md",
      targetDirectory: "学习",
    });
    expect(collision.ok).toBe(false);
    if (!collision.ok)
      expect(collision.error.code).toBe("VAULT_PATH_COLLISION");

    const reserved = await call(IPC_CHANNELS.noteMove, {
      vaultId,
      relativePath: "a.md",
      targetDirectory: "assets",
    });
    expect(reserved.ok).toBe(false);
    if (!reserved.ok) expect(reserved.error.code).toBe("VAULT_RESERVED_PATH");
  });

  it("renameFile 成功：新路径返回 + 自写登记；非 .md 与冲突报错", async () => {
    const vaultId = await registerVault();
    await writeFile(join(vaultRoot, "a.md"), "# a\n", "utf8");
    await writeFile(join(vaultRoot, "b.md"), "# b\n", "utf8");

    const result = await call(IPC_CHANNELS.noteRenameFile, {
      vaultId,
      relativePath: "a.md",
      newName: "a2.md",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value as RenameNoteFileResult).relativePath).toBe("a2.md");
    expect(selfWrites.shouldSuppress(vaultId, "a.md", null)).toBe(true);
    expect(selfWrites.shouldSuppress(vaultId, "a2.md", null)).toBe(true);

    const invalid = await call(IPC_CHANNELS.noteRenameFile, {
      vaultId,
      relativePath: "a2.md",
      newName: "a2.txt",
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe("INVALID_INPUT");

    const collision = await call(IPC_CHANNELS.noteRenameFile, {
      vaultId,
      relativePath: "a2.md",
      newName: "b.md",
    });
    expect(collision.ok).toBe(false);
    if (!collision.ok)
      expect(collision.error.code).toBe("VAULT_PATH_COLLISION");
  });

  it("transient → VAULT_READ_ONLY（move / renameFile）", async () => {
    const transientId = transients.add(vaultRoot, "预览库");
    await writeFile(join(vaultRoot, "a.md"), "# a\n", "utf8");
    for (const [channel, payload] of [
      [
        IPC_CHANNELS.noteMove,
        { vaultId: transientId, relativePath: "a.md", targetDirectory: "" },
      ],
      [
        IPC_CHANNELS.noteRenameFile,
        { vaultId: transientId, relativePath: "a.md", newName: "b.md" },
      ],
    ] as const) {
      const result = await call(channel, payload);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("VAULT_READ_ONLY");
    }
    expect(await exists("a.md")).toBe(true);
  });
});
