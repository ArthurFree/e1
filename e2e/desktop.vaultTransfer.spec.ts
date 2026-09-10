// R014 Stage 7：Vault 可移植性与跨库操作 Desktop Golden E2E（G57–G71）。
import { test, expect, _electron as electron } from "@playwright/test";
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
import { requireDesktopArtifacts } from "./desktopArtifacts";

const SRC_ID = "v-e2e-vt-src";
const DST_ID = "v-e2e-vt-dst";

function note(id: string, title: string, body: string): string {
  return ["---", `id: ${id}`, `title: ${title}`, "---", "", body, ""].join(
    "\n",
  );
}

async function fileExists(abs: string): Promise<boolean> {
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

interface DualFixture {
  srcDir: string;
  dstDir: string;
  userDataDir: string;
  cleanup(): Promise<void>;
}

async function createDualFixture(
  srcFiles: Array<[string, string]>,
  dstFiles: Array<[string, string]> = [],
): Promise<DualFixture> {
  const srcDir = await mkdtemp(path.join(os.tmpdir(), "e1-vt-src-"));
  const dstDir = await mkdtemp(path.join(os.tmpdir(), "e1-vt-dst-"));
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
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "e1-vt-ud-"));
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

function launch(
  userDataDir: string,
  extraEnv: Record<string, string> = {},
) {
  const env = { ...process.env, ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({
    args: ["."],
    env: { ...env, E1_USER_DATA_DIR: userDataDir },
  });
}

interface TransferPlan {
  operationId: string;
  kind: string;
  blockers: Array<{ code: string }>;
  warnings: Array<{ code: string }>;
  notes: Array<{
    sourcePath: string;
    destinationPath: string;
    sourceStableId: string | null;
    destinationStableId: string;
  }>;
  assets: Array<{ destinationPath: string; reuseExisting: boolean }>;
  revisions: unknown[];
  sourceFingerprint: string;
  destinationFingerprint: string;
}

function transferOf(window: Page) {
  return {
    plan: (input: Record<string, unknown>) =>
      window.evaluate(async (payload) => {
        const e1 = (
          window as unknown as {
            e1?: {
              vaultTransfer?: {
                plan: (i: Record<string, unknown>) => Promise<TransferPlan>;
              };
              vault?: {
                selectDirectory: () => Promise<{ selectionToken: string } | null>;
              };
            };
          }
        ).e1;
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
        const e1 = (
          window as unknown as {
            e1?: {
              vaultTransfer?: {
                execute: (i: { plan: TransferPlan }) => Promise<unknown>;
              };
            };
          }
        ).e1;
        if (!e1?.vaultTransfer) throw new Error("vaultTransfer 未暴露");
        return e1.vaultTransfer.execute({ plan: p });
      }, plan),
    executeFail: (plan: TransferPlan) =>
      window.evaluate(async (p) => {
        const e1 = (
          window as unknown as {
            e1?: {
              vaultTransfer?: {
                execute: (i: { plan: TransferPlan }) => Promise<unknown>;
              };
            };
          }
        ).e1;
        if (!e1?.vaultTransfer) throw new Error("vaultTransfer 未暴露");
        try {
          await e1.vaultTransfer.execute({ plan: p });
          return { ok: true as const, message: "" };
        } catch (err) {
          return {
            ok: false as const,
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }, plan),
    recoveryStatus: () =>
      window.evaluate(async () => {
        const e1 = (
          window as unknown as {
            e1?: {
              vaultTransfer?: {
                recoveryStatus: () => Promise<{
                  phase: string;
                  pendingOperationIds: string[];
                }>;
              };
            };
          }
        ).e1;
        return e1?.vaultTransfer?.recoveryStatus();
      }),
    recover: () =>
      window.evaluate(async () => {
        const e1 = (
          window as unknown as {
            e1?: {
              vaultTransfer?: {
                recover: () => Promise<{ recovered: boolean }>;
              };
            };
          }
        ).e1;
        return e1?.vaultTransfer?.recover();
      }),
  };
}

async function waitAppReady(window: Page) {
  await window.waitForLoadState("domcontentloaded");
  await expect
    .poll(
      async () =>
        window.evaluate(() => {
          const e1 = (
            window as unknown as { e1?: { vaultTransfer?: unknown } }
          ).e1;
          return Boolean(e1?.vaultTransfer);
        }),
      { timeout: 15_000 },
    )
    .toBe(true);
  await expect(window.getByRole("tree").first()).toBeVisible({
    timeout: 15_000,
  });
}

test.describe("桌面冒烟：R014 Vault 可移植与跨库（G57–G71）", () => {
  test.beforeAll(() => {
    requireDesktopArtifacts();
  });

  test("@golden G57：missing Vault → relocate → 可再打开", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "e1-vt-g57-"));
    const dummy = path.join(parent, "dummy");
    const oldDir = path.join(parent, "old");
    const newDir = path.join(parent, "new");
    await mkdir(dummy);
    await mkdir(oldDir);
    await writeVault(dummy, DST_ID, "dummy");
    await writeVault(oldDir, SRC_ID, "old");
    await writeFile(path.join(oldDir, "a.md"), note("id-a", "A", "hello"));
    await rename(oldDir, newDir);
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "e1-vt-ud-"));
    await writeFile(
      path.join(userDataDir, "recent-vaults.json"),
      JSON.stringify([
        {
          vaultId: DST_ID,
          absolutePath: dummy,
          displayName: "dummy",
          lastOpenedAt: "2026-08-11T00:00:00.000Z",
        },
        {
          vaultId: SRC_ID,
          absolutePath: oldDir,
          displayName: "old",
          lastOpenedAt: "2026-08-10T00:00:00.000Z",
        },
      ]),
    );
    const app = await launch(userDataDir, { E1_SELECT_DIRECTORY: newDir });
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      const bridge = transferOf(window);
      const plan = await bridge.plan({
        kind: "relocate-missing",
        sourceVaultId: SRC_ID,
        needsToken: true,
      });
      expect(plan.blockers).toEqual([]);
      await bridge.execute(plan);
      const scan = await window.evaluate(async (vid) => {
        const e1 = (
          window as unknown as {
            e1?: { vault?: { scan: (id: string) => Promise<{ entries: unknown[] }> } };
          }
        ).e1;
        return e1?.vault?.scan(vid);
      }, SRC_ID);
      expect((scan?.entries ?? []).length).toBeGreaterThan(0);
    } finally {
      await app.close();
      await rm(parent, { recursive: true, force: true });
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("@golden G58：物理根目录改名", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "e1-vt-g58-"));
    const src = path.join(parent, "MyVault");
    await mkdir(src);
    await writeVault(src, SRC_ID, "MyVault");
    await writeFile(path.join(src, "n.md"), note("id-n", "N", "body"));
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "e1-vt-ud-"));
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
    const app = await launch(userDataDir, { E1_SELECT_DIRECTORY: parent });
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      const bridge = transferOf(window);
      const plan = await bridge.plan({
        kind: "relocate-vault",
        sourceVaultId: SRC_ID,
        newFolderName: "Frontend",
        needsToken: true,
      });
      expect(plan.blockers).toEqual([]);
      await bridge.execute(plan);
      expect(await fileExists(path.join(parent, "Frontend", "n.md"))).toBe(
        true,
      );
      expect(await fileExists(path.join(src, "n.md"))).toBe(false);
    } finally {
      await app.close();
      await rm(parent, { recursive: true, force: true });
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("@golden G59：搬到另一父目录（同卷）", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "e1-vt-g59-"));
    const src = path.join(root, "from", "Vault");
    const destParent = path.join(root, "to");
    await mkdir(src, { recursive: true });
    await mkdir(destParent, { recursive: true });
    await writeVault(src, SRC_ID, "Vault");
    await writeFile(path.join(src, "n.md"), note("id-n", "N", "body"));
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "e1-vt-ud-"));
    await writeFile(
      path.join(userDataDir, "recent-vaults.json"),
      JSON.stringify([
        {
          vaultId: SRC_ID,
          absolutePath: src,
          displayName: "Vault",
          lastOpenedAt: "2026-08-10T00:00:00.000Z",
        },
      ]),
    );
    const app = await launch(userDataDir, { E1_SELECT_DIRECTORY: destParent });
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      const bridge = transferOf(window);
      const plan = await bridge.plan({
        kind: "relocate-vault",
        sourceVaultId: SRC_ID,
        newFolderName: "Vault",
        needsToken: true,
      });
      expect(plan.blockers).toEqual([]);
      await bridge.execute(plan);
      expect(await fileExists(path.join(destParent, "Vault", "n.md"))).toBe(
        true,
      );
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("@golden G60：copy document → 新 stable id", async () => {
    const fixture = await createDualFixture([
      ["a.md", note("id-src-a", "甲", "正文甲")],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      const bridge = transferOf(window);
      const plan = await bridge.plan({
        kind: "copy-document",
        sourceVaultId: SRC_ID,
        destinationVaultId: DST_ID,
        sourceRelativePath: "a.md",
        destinationRelativePath: "",
      });
      expect(plan.blockers).toEqual([]);
      expect(plan.notes[0]?.destinationStableId).not.toBe("id-src-a");
      await bridge.execute(plan);
      const dest = await readFile(path.join(fixture.dstDir, "a.md"), "utf8");
      expect(dest).toContain(plan.notes[0]!.destinationStableId);
      expect(dest).not.toContain("id: id-src-a");
      expect(await fileExists(path.join(fixture.srcDir, "a.md"))).toBe(true);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G61/G62：copy group 内部链接与附件", async () => {
    const fixture = await createDualFixture([
      ["组/a.md", note("id-a", "A", "见 [B](b.md)。![图](../assets/x.png)")],
      ["组/b.md", note("id-b", "B", "B")],
      ["assets/x.png", "png"],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      const bridge = transferOf(window);
      const plan = await bridge.plan({
        kind: "copy-group",
        sourceVaultId: SRC_ID,
        destinationVaultId: DST_ID,
        sourceRelativePath: "组",
        destinationRelativePath: "",
      });
      expect(plan.blockers).toEqual([]);
      await bridge.execute(plan);
      const destA = await readFile(
        path.join(fixture.dstDir, "组", "a.md"),
        "utf8",
      );
      expect(destA).toContain("(b.md)");
      expect(await fileExists(path.join(fixture.dstDir, "assets", "x.png"))).toBe(
        true,
      );
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G63：move document 保持 stable id", async () => {
    const fixture = await createDualFixture([
      ["solo.md", note("id-solo", "独", "独正文")],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      const bridge = transferOf(window);
      const plan = await bridge.plan({
        kind: "move-document",
        sourceVaultId: SRC_ID,
        destinationVaultId: DST_ID,
        sourceRelativePath: "solo.md",
        destinationRelativePath: "",
      });
      expect(plan.notes[0]?.destinationStableId).toBe("id-solo");
      await bridge.execute(plan);
      const dest = await readFile(path.join(fixture.dstDir, "solo.md"), "utf8");
      expect(dest).toContain("id: id-solo");
      expect(await fileExists(path.join(fixture.srcDir, "solo.md"))).toBe(
        false,
      );
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G64：move group 带 revision 目录", async () => {
    const fixture = await createDualFixture([
      ["组/h.md", note("idHist01", "史", "第一版")],
    ]);
    await mkdir(path.join(fixture.srcDir, ".e1", "revisions", "series", "sn_idHist01"), {
      recursive: true,
    });
    await writeFile(
      path.join(
        fixture.srcDir,
        ".e1",
        "revisions",
        "series",
        "sn_idHist01",
        "marker.txt",
      ),
      "kept",
    );
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      const bridge = transferOf(window);
      const plan = await bridge.plan({
        kind: "move-group",
        sourceVaultId: SRC_ID,
        destinationVaultId: DST_ID,
        sourceRelativePath: "组",
        destinationRelativePath: "",
      });
      await bridge.execute(plan);
      expect(
        await fileExists(
          path.join(
            fixture.dstDir,
            ".e1",
            "revisions",
            "series",
            "sn_idHist01",
            "marker.txt",
          ),
        ),
      ).toBe(true);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G65：inbound boundary 阻断 move", async () => {
    const fixture = await createDualFixture([
      ["keep.md", note("id-k", "留", "见 [走](go.md)。")],
      ["go.md", note("id-g", "走", "走。")],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      const plan = await transferOf(window).plan({
        kind: "move-document",
        sourceVaultId: SRC_ID,
        destinationVaultId: DST_ID,
        sourceRelativePath: "go.md",
        destinationRelativePath: "",
      });
      expect(plan.blockers.some((b) => b.code.includes("BOUNDARY_INBOUND"))).toBe(
        true,
      );
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G66：outbound boundary 阻断 move", async () => {
    const fixture = await createDualFixture([
      ["stay.md", note("id-s", "留", "留。")],
      ["leave.md", note("id-l", "走", "见 [留](stay.md)。")],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      const plan = await transferOf(window).plan({
        kind: "move-document",
        sourceVaultId: SRC_ID,
        destinationVaultId: DST_ID,
        sourceRelativePath: "leave.md",
        destinationRelativePath: "",
      });
      expect(
        plan.blockers.some((b) => b.code.includes("BOUNDARY_OUTBOUND")),
      ).toBe(true);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G67：Move 碰撞不覆盖", async () => {
    const fixture = await createDualFixture(
      [["same.md", note("id-src", "源", "源")]],
      [["same.md", note("id-dst", "目标", "目标")]],
    );
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      const plan = await transferOf(window).plan({
        kind: "move-document",
        sourceVaultId: SRC_ID,
        destinationVaultId: DST_ID,
        sourceRelativePath: "same.md",
        destinationRelativePath: "",
      });
      expect(plan.blockers.some((b) => b.code.includes("COLLISION"))).toBe(
        true,
      );
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G68/G69：源或目标在预检后变化则 stale", async () => {
    const fixture = await createDualFixture([
      ["x.md", note("id-x", "X", "旧")],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      const bridge = transferOf(window);
      const plan = await bridge.plan({
        kind: "copy-document",
        sourceVaultId: SRC_ID,
        destinationVaultId: DST_ID,
        sourceRelativePath: "x.md",
        destinationRelativePath: "",
      });
      await writeFile(
        path.join(fixture.srcDir, "x.md"),
        note("id-x", "X", "新内容更长一些"),
      );
      const failed = await bridge.executeFail(plan);
      expect(failed.ok).toBe(false);
      expect(failed.message).toMatch(/预检|变化|过期/);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G70：引用式链接改写", async () => {
    const fixture = await createDualFixture([
      [
        "组/a.md",
        note("id-a", "A", "[B][target]\n\n[target]: b.md\n"),
      ],
      ["组/b.md", note("id-b", "B", "B")],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      const bridge = transferOf(window);
      const plan = await bridge.plan({
        kind: "copy-group",
        sourceVaultId: SRC_ID,
        destinationVaultId: DST_ID,
        sourceRelativePath: "组",
        destinationRelativePath: "",
      });
      await bridge.execute(plan);
      const destA = await readFile(
        path.join(fixture.dstDir, "组", "a.md"),
        "utf8",
      );
      expect(destA).toContain("[B][target]");
      expect(destA).toContain("[target]: b.md");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G71：中断搬迁 journal 可恢复", async () => {
    const fixture = await createDualFixture([
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
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      const status = await transferOf(window).recoveryStatus();
      expect(status?.phase === "clean" || status?.phase === "recoverable").toBe(
        true,
      );
      await transferOf(window).recover();
      expect(await fileExists(path.join(fixture.srcDir, "a.md"))).toBe(true);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G69b：预检后目标附件变化则 stale 且不覆盖", async () => {
    const fixture = await createDualFixture([
      ["a.md", note("id-a", "A", "![图](assets/pic.bin)")],
      ["assets/pic.bin", "source-bytes"],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      const bridge = transferOf(window);
      const plan = await bridge.plan({
        kind: "copy-document",
        sourceVaultId: SRC_ID,
        destinationVaultId: DST_ID,
        sourceRelativePath: "a.md",
        destinationRelativePath: "",
      });
      expect(plan.assets.length).toBeGreaterThan(0);
      const destAsset = path.join(
        fixture.dstDir,
        plan.assets[0]!.destinationPath,
      );
      await mkdir(path.dirname(destAsset), { recursive: true });
      await writeFile(destAsset, "planted-after-preflight");
      const failed = await bridge.executeFail(plan);
      expect(failed.ok).toBe(false);
      expect(failed.message).toMatch(/预检|变化|过期|占用/);
      expect(await readFile(destAsset, "utf8")).toBe("planted-after-preflight");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G69c：预检后目标出现同 stable ID 则 stale", async () => {
    const fixture = await createDualFixture([
      ["a.md", note("id-race", "源", "源")],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      const bridge = transferOf(window);
      const plan = await bridge.plan({
        kind: "move-document",
        sourceVaultId: SRC_ID,
        destinationVaultId: DST_ID,
        sourceRelativePath: "a.md",
        destinationRelativePath: "",
      });
      await writeFile(
        path.join(fixture.dstDir, "sneak.md"),
        note("id-race", "偷", "偷"),
      );
      const failed = await bridge.executeFail(plan);
      expect(failed.ok).toBe(false);
      expect(failed.message).toMatch(/预检|变化|过期|身份/);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G69d：预检后目标出现 revision series 则 stale", async () => {
    const fixture = await createDualFixture([
      ["h.md", note("idHistG69d", "史", "第一版")],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      await window.evaluate(async (vid) => {
        const e1 = (
          window as unknown as {
            e1?: {
              revisions?: {
                capture: (i: Record<string, unknown>) => Promise<unknown>;
              };
            };
          }
        ).e1;
        await e1?.revisions?.capture({
          vaultId: vid,
          relativePath: "h.md",
          stableNoteId: "idHistG69d",
          reason: "manual",
        });
      }, SRC_ID);
      const bridge = transferOf(window);
      const plan = await bridge.plan({
        kind: "move-document",
        sourceVaultId: SRC_ID,
        destinationVaultId: DST_ID,
        sourceRelativePath: "h.md",
        destinationRelativePath: "",
      });
      expect(plan.revisions.length).toBeGreaterThan(0);
      const seriesDir = path.join(
        fixture.dstDir,
        ".e1",
        "revisions",
        "series",
        "sn_idHistG69d",
      );
      await mkdir(seriesDir, { recursive: true });
      await writeFile(path.join(seriesDir, "series.json"), "{}");
      const failed = await bridge.executeFail(plan);
      expect(failed.ok).toBe(false);
      expect(failed.message).toMatch(/预检|变化|过期|版本历史/);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G71b：rename 已完成 journal 停在 rename-intent → 推进 registry", async () => {
    const fixture = await createDualFixture([["a.md", note("id-a", "A", "a")]]);
    const dest = `${fixture.srcDir}-relocated`;
    await rename(fixture.srcDir, dest);
    const journalDir = path.join(fixture.userDataDir, "vault-relocations");
    await mkdir(journalDir, { recursive: true });
    await writeFile(
      path.join(journalDir, "op-g71b.json"),
      JSON.stringify({
        version: 2,
        operationId: "op-g71b",
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
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      await transferOf(window).recover();
      const recent = JSON.parse(
        await readFile(
          path.join(fixture.userDataDir, "recent-vaults.json"),
          "utf8",
        ),
      ) as Array<{ vaultId: string; absolutePath: string }>;
      expect(recent.find((v) => v.vaultId === SRC_ID)?.absolutePath).toBe(dest);
      expect(await fileExists(path.join(dest, "a.md"))).toBe(true);
    } finally {
      await app.close();
      await rm(dest, { recursive: true, force: true });
      await fixture.cleanup();
    }
  });

  test("@golden G71c：destination-ready + crash before registry → 补 registry", async () => {
    const fixture = await createDualFixture([["a.md", note("id-a", "A", "a")]]);
    const dest = `${fixture.srcDir}-copied`;
    await mkdir(dest, { recursive: true });
    const vaultJson = await readFile(
      path.join(fixture.srcDir, ".e1", "vault.json"),
      "utf8",
    );
    await mkdir(path.join(dest, ".e1"), { recursive: true });
    await writeFile(path.join(dest, ".e1", "vault.json"), vaultJson);
    await writeFile(path.join(dest, "a.md"), note("id-a", "A", "a"));
    const journalDir = path.join(fixture.userDataDir, "vault-relocations");
    await mkdir(journalDir, { recursive: true });
    await writeFile(
      path.join(journalDir, "op-g71c.json"),
      JSON.stringify({
        version: 2,
        operationId: "op-g71c",
        vaultId: SRC_ID,
        sourcePath: fixture.srcDir,
        destinationPath: dest,
        strategy: "copy-verify-delete",
        phase: "destination-ready",
        sourceFingerprint: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      await transferOf(window).recover();
      const recent = JSON.parse(
        await readFile(
          path.join(fixture.userDataDir, "recent-vaults.json"),
          "utf8",
        ),
      ) as Array<{ vaultId: string; absolutePath: string }>;
      expect(recent.find((v) => v.vaultId === SRC_ID)?.absolutePath).toBe(dest);
      expect(await fileExists(path.join(fixture.srcDir, "a.md"))).toBe(true);
    } finally {
      await app.close();
      await rm(dest, { recursive: true, force: true });
      await fixture.cleanup();
    }
  });

  test("@golden G71d：源与目标都在 → manual-required，不自动删除", async () => {
    const fixture = await createDualFixture([["a.md", note("id-a", "A", "a")]]);
    const journalDir = path.join(fixture.userDataDir, "vault-relocations");
    await mkdir(journalDir, { recursive: true });
    await writeFile(
      path.join(journalDir, "op-g71d.json"),
      JSON.stringify({
        version: 2,
        operationId: "op-g71d",
        vaultId: SRC_ID,
        sourcePath: fixture.srcDir,
        destinationPath: fixture.dstDir,
        strategy: "rename",
        phase: "rename-intent",
        sourceFingerprint: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      const status = await transferOf(window).recoveryStatus();
      expect(status?.phase).toBe("manual-required");
      expect(await fileExists(path.join(fixture.srcDir, "a.md"))).toBe(true);
      expect(await fileExists(path.join(fixture.dstDir, ".e1", "vault.json"))).toBe(
        true,
      );
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G71e：源与目标都缺失 → manual-required", async () => {
    const fixture = await createDualFixture([["a.md", note("id-a", "A", "a")]]);
    const journalDir = path.join(fixture.userDataDir, "vault-relocations");
    await mkdir(journalDir, { recursive: true });
    await writeFile(
      path.join(journalDir, "op-g71e.json"),
      JSON.stringify({
        version: 2,
        operationId: "op-g71e",
        vaultId: SRC_ID,
        sourcePath: path.join(fixture.srcDir, "missing-src"),
        destinationPath: path.join(fixture.dstDir, "missing-dst"),
        strategy: "rename",
        phase: "rename-intent",
        sourceFingerprint: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      const status = await transferOf(window).recoveryStatus();
      expect(status?.phase).toBe("manual-required");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G71f：Move dest 完成 crash before trash → 源仍在，显式 recover 才回收", async () => {
    const fixture = await createDualFixture([
      ["solo.md", note("id-solo", "独", "独正文")],
    ]);
    await writeFile(
      path.join(fixture.dstDir, "solo.md"),
      note("id-solo", "独", "独正文"),
    );
    const journalDir = path.join(fixture.userDataDir, "vault-transfers");
    await mkdir(journalDir, { recursive: true });
    await writeFile(
      path.join(journalDir, "op-g71f.json"),
      JSON.stringify({
        version: 1,
        operationId: "op-g71f",
        kind: "move-document",
        sourceVaultId: SRC_ID,
        destinationVaultId: DST_ID,
        sourceRelativePath: "solo.md",
        phase: "destination-ready",
        destinationNotePaths: ["solo.md"],
        destinationAssetPaths: [],
        destinationRevisionSeries: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      expect(await fileExists(path.join(fixture.srcDir, "solo.md"))).toBe(true);
      const status = await transferOf(window).recoveryStatus();
      expect(status?.phase).toBe("manual-required");
      await transferOf(window).recover();
      expect(await fileExists(path.join(fixture.srcDir, "solo.md"))).toBe(false);
      expect(await fileExists(path.join(fixture.dstDir, "solo.md"))).toBe(true);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G71g：Move 源已 trash crash before commit → 认 dest 已提交", async () => {
    const fixture = await createDualFixture([
      ["solo.md", note("id-solo", "独", "独正文")],
    ]);
    await writeFile(
      path.join(fixture.dstDir, "solo.md"),
      note("id-solo", "独", "独正文"),
    );
    await rm(path.join(fixture.srcDir, "solo.md"));
    const journalDir = path.join(fixture.userDataDir, "vault-transfers");
    await mkdir(journalDir, { recursive: true });
    await writeFile(
      path.join(journalDir, "op-g71g.json"),
      JSON.stringify({
        version: 1,
        operationId: "op-g71g",
        kind: "move-document",
        sourceVaultId: SRC_ID,
        destinationVaultId: DST_ID,
        sourceRelativePath: "solo.md",
        phase: "source-trashed",
        destinationNotePaths: ["solo.md"],
        destinationAssetPaths: [],
        destinationRevisionSeries: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      await transferOf(window).recover();
      expect(await fileExists(path.join(fixture.dstDir, "solo.md"))).toBe(true);
      expect(await fileExists(path.join(fixture.srcDir, "solo.md"))).toBe(false);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });
});

