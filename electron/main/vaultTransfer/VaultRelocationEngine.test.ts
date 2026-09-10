// @vitest-environment node
/**
 * R014 Stage 1–2：Missing Relocate + Physical Relocation 单元测试。
 */
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeVault } from "../filesystem/VaultFileSystem.js";
import { VaultRegistry } from "../vaultRegistry.js";
import {
  executeRelocateMissing,
  executeRelocateVault,
  planRelocateMissing,
  planRelocateVault,
  recoverRelocations,
  relocationJournalDir,
} from "./VaultRelocationEngine.js";
import { VAULT_TRANSFER_BLOCKER_CODES as CODES } from "../../../shared/vaultTransfer/types.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function note(id: string, title: string, body: string): string {
  return `---\nid: ${id}\ntitle: ${title}\n---\n\n${body}\n`;
}

describe("Missing Vault Relocate", () => {
  it("原路径仍可访问 → blocker", async () => {
    const root = await tmp("e1-reloc-src-");
    const meta = await initializeVault(root, "源");
    const user = await tmp("e1-reloc-ud-");
    const registry = new VaultRegistry(join(user, "recent-vaults.json"));
    await registry.touch({
      vaultId: meta.vaultId,
      absolutePath: root,
      displayName: "源",
    });
    const plan = await planRelocateMissing({
      sourceVaultId: meta.vaultId,
      destinationAbsolutePath: root,
      registry,
    });
    expect(plan.blockers.some((b) => b.code === CODES.sourceAccessible)).toBe(
      true,
    );
  });

  it("vaultId mismatch 拒绝", async () => {
    const oldRoot = await tmp("e1-reloc-old-");
    const dest = await tmp("e1-reloc-dest-");
    const meta = await initializeVault(oldRoot, "甲");
    await initializeVault(dest, "乙");
    const user = await tmp("e1-reloc-ud-");
    const registry = new VaultRegistry(join(user, "recent-vaults.json"));
    await registry.touch({
      vaultId: meta.vaultId,
      absolutePath: join(oldRoot, "gone"),
      displayName: "甲",
    });
    const plan = await planRelocateMissing({
      sourceVaultId: meta.vaultId,
      destinationAbsolutePath: dest,
      registry,
    });
    expect(plan.blockers.some((b) => b.code === CODES.vaultIdMismatch)).toBe(
      true,
    );
  });

  it("missing → 匹配 vaultId 后更新 registry", async () => {
    const oldRoot = await tmp("e1-reloc-old-");
    const dest = await tmp("e1-reloc-dest-");
    const meta = await initializeVault(oldRoot, "甲");
    await writeFile(join(oldRoot, "a.md"), note("id-a", "A", "hello"));
    await rename(oldRoot, dest);
    const user = await tmp("e1-reloc-ud-");
    const registry = new VaultRegistry(join(user, "recent-vaults.json"));
    await registry.touch({
      vaultId: meta.vaultId,
      absolutePath: oldRoot,
      displayName: "甲",
    });
    const plan = await planRelocateMissing({
      sourceVaultId: meta.vaultId,
      destinationAbsolutePath: dest,
      registry,
    });
    expect(plan.blockers).toEqual([]);
    await executeRelocateMissing({
      plan,
      destinationAbsolutePath: dest,
      registry,
    });
    const found = await registry.findByVaultId(meta.vaultId);
    expect(found?.absolutePath).toBe(dest);
  });
});

describe("Physical Vault Relocation", () => {
  it("同卷 rename 后 registry 指向新根", async () => {
    const parent = await tmp("e1-reloc-parent-");
    const src = join(parent, "MyVault");
    await mkdir(src);
    const meta = await initializeVault(src, "库");
    await writeFile(join(src, "n.md"), note("id-n", "N", "body"));
    const user = await tmp("e1-reloc-ud-");
    const registry = new VaultRegistry(join(user, "recent-vaults.json"));
    await registry.touch({
      vaultId: meta.vaultId,
      absolutePath: src,
      displayName: "库",
    });
    const plan = await planRelocateVault({
      sourceVaultId: meta.vaultId,
      destinationParentAbsolutePath: parent,
      newFolderName: "Frontend",
      registry,
    });
    expect(plan.blockers).toEqual([]);
    await executeRelocateVault({
      plan,
      destinationParentAbsolutePath: parent,
      journalDir: relocationJournalDir(user),
      registry,
    });
    const dest = join(parent, "Frontend");
    const found = await registry.findByVaultId(meta.vaultId);
    expect(found?.absolutePath).toBe(dest);
    expect(await readFile(join(dest, "n.md"), "utf8")).toContain("body");
    await expect(readFile(join(src, "n.md"), "utf8")).rejects.toThrow();
  });

  it("EXDEV 走 copy-verify-delete，源在校验完成前仍在", async () => {
    const parent = await tmp("e1-reloc-xdev-");
    const src = join(parent, "SrcVault");
    await mkdir(src);
    const meta = await initializeVault(src, "库");
    await writeFile(join(src, "n.md"), note("id-n", "N", "body"));
    const user = await tmp("e1-reloc-ud-");
    const registry = new VaultRegistry(join(user, "recent-vaults.json"));
    await registry.touch({
      vaultId: meta.vaultId,
      absolutePath: src,
      displayName: "库",
    });
    const plan = await planRelocateVault({
      sourceVaultId: meta.vaultId,
      destinationParentAbsolutePath: parent,
      newFolderName: "DestVault",
      registry,
    });
    const dest = join(parent, "DestVault");
    let sawCopy = false;
    await executeRelocateVault({
      plan,
      destinationParentAbsolutePath: parent,
      journalDir: relocationJournalDir(user),
      registry,
      fs: {
        rename: async (from, to) => {
          if (from === src && to === dest) {
            const err = new Error("cross-device") as NodeJS.ErrnoException;
            err.code = "EXDEV";
            throw err;
          }
          sawCopy = true;
          await rename(from, to);
        },
      },
    });
    expect(sawCopy).toBe(true);
    const found = await registry.findByVaultId(meta.vaultId);
    expect(found?.absolutePath).toBe(dest);
    expect(await readFile(join(dest, "n.md"), "utf8")).toContain("body");
    await expect(readFile(join(src, "n.md"), "utf8")).rejects.toThrow();
  });

  it("copying 中断恢复：清 staging，不删源", async () => {
    const user = await tmp("e1-reloc-ud-");
    const journalDir = relocationJournalDir(user);
    await mkdir(journalDir, { recursive: true });
    const src = await tmp("e1-reloc-src-");
    const dest = join(await tmp("e1-reloc-dst-"), "out");
    await writeFile(
      join(journalDir, "op-crash.json"),
      JSON.stringify({
        version: 1,
        operationId: "op-crash",
        vaultId: "v1",
        sourcePath: src,
        destinationPath: dest,
        strategy: "copy-verify-delete",
        phase: "copying",
        createdAt: new Date().toISOString(),
      }),
    );
    const staging = `${dest}.e1-relocating`;
    await mkdir(staging, { recursive: true });
    const registry = new VaultRegistry(join(user, "recent-vaults.json"));
    const result = await recoverRelocations({ journalDir, registry });
    expect(result.recovered).toContain("op-crash");
    await expect(readFile(join(staging, "x"), "utf8")).rejects.toThrow();
  });
});