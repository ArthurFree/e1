// R014 Stage 7：Packaged App Vault 可移植性冒烟 P27–P30。
// 无安装包产物时 requirePackagedArtifact() 本地 skip、CI 抛错。
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requirePackagedArtifact } from "../desktopArtifacts";
import { launchPackaged, note } from "./packageFixture";

const SRC_ID = "v-e2e-pkg-vt-src";
const DST_ID = "v-e2e-pkg-vt-dst";

async function exists(abs: string): Promise<boolean> {
  try {
    await access(abs);
    return true;
  } catch {
    return false;
  }
}

async function writeVault(dir: string, vaultId: string, name: string) {
  await mkdir(path.join(dir, ".e1"), { recursive: true });
  await writeFile(
    path.join(dir, ".e1", "vault.json"),
    JSON.stringify({
      format: "e1-vault",
      formatVersion: 1,
      vaultId,
      name,
      createdAt: "2026-08-10T00:00:00.000Z",
      assetsDirectory: "assets",
      identityMode: "frontmatter",
    }),
  );
}

interface DualPkg {
  srcDir: string;
  dstDir: string;
  userDataDir: string;
  cleanup(): Promise<void>;
}

async function createDualPackageVaults(
  srcFiles: Array<[string, string]>,
  dstFiles: Array<[string, string]> = [],
): Promise<DualPkg> {
  const srcDir = await mkdtemp(path.join(os.tmpdir(), "e1-pkg-vt-src-"));
  const dstDir = await mkdtemp(path.join(os.tmpdir(), "e1-pkg-vt-dst-"));
  for (const [rel, content] of srcFiles) {
    const abs = path.join(srcDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  for (const [rel, content] of dstFiles) {
    const abs = path.join(dstDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  await writeVault(srcDir, SRC_ID, path.basename(srcDir));
  await writeVault(dstDir, DST_ID, path.basename(dstDir));
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "e1-pkg-vt-ud-"));
  await writeFile(
    path.join(userDataDir, "recent-vaults.json"),
    JSON.stringify([
      {
        vaultId: SRC_ID,
        absolutePath: srcDir,
        displayName: path.basename(srcDir),
        lastOpenedAt: "2026-08-10T00:00:00.000Z",
      },
      {
        vaultId: DST_ID,
        absolutePath: dstDir,
        displayName: path.basename(dstDir),
        lastOpenedAt: "2026-08-09T00:00:00.000Z",
      },
    ]),
  );
  return {
    srcDir,
    dstDir,
    userDataDir,
    async cleanup() {
      await rm(srcDir, { recursive: true, force: true });
      await rm(dstDir, { recursive: true, force: true });
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}

interface TransferPlan {
  operationId: string;
  kind: string;
  blockers: Array<{ code: string }>;
  notes: Array<{
    destinationPath: string;
    destinationStableId: string;
    sourceStableId: string | null;
  }>;
  assets: Array<{ destinationPath: string }>;
  revisions: unknown[];
}

interface PackageTransferBridge {
  vaultTransfer?: {
    plan: (i: Record<string, unknown>) => Promise<TransferPlan>;
    execute: (i: { plan: TransferPlan }) => Promise<unknown>;
    recover: () => Promise<{ recovered: boolean }>;
    recoveryStatus: () => Promise<{ phase: string }>;
  };
  vault?: {
    selectDirectory: () => Promise<{ selectionToken: string } | null>;
  };
  revisions?: {
    capture: (i: {
      vaultId: string;
      relativePath: string;
      stableNoteId?: string | null;
      reason: "interval" | "manual" | "before-restore";
    }) => Promise<unknown>;
    list: (i: {
      vaultId: string;
      relativePath: string;
      stableNoteId?: string | null;
    }) => Promise<{ summaries: unknown[] }>;
  };
}

async function waitPackagedReady(window: Page) {
  await window.waitForLoadState("domcontentloaded");
  await expect
    .poll(
      async () =>
        window.evaluate(() =>
          Boolean(
            (window as unknown as { e1?: PackageTransferBridge }).e1
              ?.vaultTransfer,
          ),
        ),
      { timeout: 20_000 },
    )
    .toBe(true);
  await expect(window.getByRole("tree").first()).toBeVisible({
    timeout: 20_000,
  });
}

function transferOf(window: Page) {
  return {
    plan: (input: Record<string, unknown>) =>
      window.evaluate(async (payload) => {
        const e1 = (window as unknown as { e1?: PackageTransferBridge }).e1;
        if (!e1?.vaultTransfer) throw new Error("vaultTransfer 未暴露");
        if (payload.needsToken) {
          const selected = await e1.vault?.selectDirectory();
          if (!selected) throw new Error("selectDirectory 未返回令牌");
          payload = { ...payload, selectionToken: selected.selectionToken };
          delete payload.needsToken;
        }
        return e1.vaultTransfer.plan(payload);
      }, input),
    execute: (plan: TransferPlan) =>
      window.evaluate(async (p) => {
        const e1 = (window as unknown as { e1?: PackageTransferBridge }).e1;
        if (!e1?.vaultTransfer) throw new Error("vaultTransfer 未暴露");
        return e1.vaultTransfer.execute({ plan: p });
      }, plan),
  };
}

test.describe("安装包冒烟：R014 Vault 可移植（P27–P30）", () => {
  test.beforeAll(() => {
    requirePackagedArtifact();
  });

  test("P27：打包产物物理根目录搬迁", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "e1-pkg-p27-"));
    const src = path.join(parent, "MyVault");
    await mkdir(src);
    await writeVault(src, SRC_ID, "MyVault");
    await writeFile(path.join(src, "n.md"), note("id-n", "N", "body"));
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "e1-pkg-p27-ud-"));
    await writeFile(
      path.join(userDataDir, "recent-vaults.json"),
      JSON.stringify([
        {
          vaultId: SRC_ID,
          absolutePath: src,
          displayName: "MyVault",
          lastOpenedAt: "2026-08-10T00:00:00.000Z",
        },
      ]),
    );
    const app = await launchPackaged(userDataDir, {
      env: { E1_SELECT_DIRECTORY: parent },
    });
    try {
      const window = await app.firstWindow();
      await waitPackagedReady(window);
      const plan = await transferOf(window).plan({
        kind: "relocate-vault",
        sourceVaultId: SRC_ID,
        newFolderName: "Frontend",
        needsToken: true,
      });
      expect(plan.blockers).toEqual([]);
      await transferOf(window).execute(plan);
      expect(await exists(path.join(parent, "Frontend", "n.md"))).toBe(true);
      expect(await exists(path.join(src, "n.md"))).toBe(false);
    } finally {
      await app.close();
      await rm(parent, { recursive: true, force: true });
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("P28：打包产物跨库 Copy 生成新 stable id", async () => {
    const fixture = await createDualPackageVaults([
      ["a.md", note("id-src-a", "甲", "正文甲")],
    ]);
    const app = await launchPackaged(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitPackagedReady(window);
      const plan = await transferOf(window).plan({
        kind: "copy-document",
        sourceVaultId: SRC_ID,
        destinationVaultId: DST_ID,
        sourceRelativePath: "a.md",
        destinationRelativePath: "",
      });
      expect(plan.blockers).toEqual([]);
      expect(plan.notes[0]?.destinationStableId).not.toBe("id-src-a");
      await transferOf(window).execute(plan);
      const dest = await readFile(path.join(fixture.dstDir, "a.md"), "utf8");
      expect(dest).toContain(plan.notes[0]!.destinationStableId);
      expect(dest).not.toContain("id: id-src-a");
      expect(await exists(path.join(fixture.srcDir, "a.md"))).toBe(true);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("P29：打包产物跨库 Move 保持 stable id 与 revision", async () => {
    const fixture = await createDualPackageVaults([
      ["hist.md", note("idHistP29", "史", "第一版")],
    ]);
    const app = await launchPackaged(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitPackagedReady(window);
      await window.evaluate(async (vid) => {
        const e1 = (window as unknown as { e1?: PackageTransferBridge }).e1;
        await e1?.revisions?.capture({
          vaultId: vid,
          relativePath: "hist.md",
          stableNoteId: "idHistP29",
          reason: "manual",
        });
      }, SRC_ID);
      const plan = await transferOf(window).plan({
        kind: "move-document",
        sourceVaultId: SRC_ID,
        destinationVaultId: DST_ID,
        sourceRelativePath: "hist.md",
        destinationRelativePath: "",
      });
      expect(plan.notes[0]?.destinationStableId).toBe("idHistP29");
      expect(plan.revisions.length).toBeGreaterThan(0);
      await transferOf(window).execute(plan);
      const dest = await readFile(path.join(fixture.dstDir, "hist.md"), "utf8");
      expect(dest).toContain("id: idHistP29");
      expect(await exists(path.join(fixture.srcDir, "hist.md"))).toBe(false);
      const listed = await window.evaluate(async (vid) => {
        const e1 = (window as unknown as { e1?: PackageTransferBridge }).e1;
        return e1?.revisions?.list({
          vaultId: vid,
          relativePath: "hist.md",
          stableNoteId: "idHistP29",
        });
      }, DST_ID);
      expect((listed?.summaries ?? []).length).toBeGreaterThan(0);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("P30：打包产物中断搬迁 journal 可恢复且不删源", async () => {
    const fixture = await createDualPackageVaults([
      ["a.md", note("id-a", "A", "a")],
    ]);
    const journalDir = path.join(fixture.userDataDir, "vault-relocations");
    await mkdir(journalDir, { recursive: true });
    await writeFile(
      path.join(journalDir, "op-crash.json"),
      JSON.stringify({
        version: 2,
        operationId: "op-crash",
        vaultId: SRC_ID,
        sourcePath: fixture.srcDir,
        destinationPath: path.join(fixture.dstDir, "unused"),
        strategy: "copy-verify-delete",
        phase: "copying",
        sourceFingerprint: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    const app = await launchPackaged(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitPackagedReady(window);
      await window.evaluate(async () => {
        const e1 = (window as unknown as { e1?: PackageTransferBridge }).e1;
        await e1?.vaultTransfer?.recover();
      });
      expect(await exists(path.join(fixture.srcDir, "a.md"))).toBe(true);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("P30b：打包产物 same-fs rename crash 恢复 registry", async () => {
    const fixture = await createDualPackageVaults([
      ["a.md", note("id-a", "A", "a")],
    ]);
    const dest = `${fixture.srcDir}-relocated`;
    await rename(fixture.srcDir, dest);
    const journalDir = path.join(fixture.userDataDir, "vault-relocations");
    await mkdir(journalDir, { recursive: true });
    await writeFile(
      path.join(journalDir, "op-p30b.json"),
      JSON.stringify({
        version: 2,
        operationId: "op-p30b",
        vaultId: SRC_ID,
        sourcePath: fixture.srcDir,
        destinationPath: dest,
        strategy: "rename",
        phase: "rename-intent",
        sourceFingerprint: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    const app = await launchPackaged(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitPackagedReady(window);
      await window.evaluate(async () => {
        const e1 = (window as unknown as { e1?: PackageTransferBridge }).e1;
        await e1?.vaultTransfer?.recover();
      });
      const recent = JSON.parse(
        await readFile(path.join(fixture.userDataDir, "recent-vaults.json"), "utf8"),
      ) as Array<{ vaultId: string; absolutePath: string }>;
      expect(recent.find((v) => v.vaultId === SRC_ID)?.absolutePath).toBe(dest);
    } finally {
      await app.close();
      await rm(dest, { recursive: true, force: true });
      await fixture.cleanup();
    }
  });

  test("P30c：打包产物预检后目标附件不覆盖", async () => {
    const fixture = await createDualPackageVaults([
      ["a.md", note("id-a", "A", "![图](assets/pic.bin)")],
      ["assets/pic.bin", "source-bytes"],
    ]);
    const app = await launchPackaged(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitPackagedReady(window);
      const plan = await transferOf(window).plan({
        kind: "copy-document",
        sourceVaultId: SRC_ID,
        destinationVaultId: DST_ID,
        sourceRelativePath: "a.md",
        destinationRelativePath: "",
      });
      const destAsset = path.join(
        fixture.dstDir,
        plan.assets[0]?.destinationPath ?? "assets/pic.bin",
      );
      await mkdir(path.dirname(destAsset), { recursive: true });
      await writeFile(destAsset, "planted-after-preflight");
      await expect(transferOf(window).execute(plan)).rejects.toThrow();
      expect(await readFile(destAsset, "utf8")).toBe("planted-after-preflight");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("P30d：打包产物 Stable ID 碰撞阻断 Move", async () => {
    const fixture = await createDualPackageVaults(
      [["a.md", note("id-shared", "源", "源")]],
      [["other.md", note("id-shared", "目标", "目标")]],
    );
    const app = await launchPackaged(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitPackagedReady(window);
      const plan = await transferOf(window).plan({
        kind: "move-document",
        sourceVaultId: SRC_ID,
        destinationVaultId: DST_ID,
        sourceRelativePath: "a.md",
        destinationRelativePath: "",
      });
      expect(plan.blockers.some((b) => b.code.includes("IDENTITY"))).toBe(true);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });
});
