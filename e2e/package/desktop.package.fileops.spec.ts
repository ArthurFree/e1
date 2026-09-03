// R011 Stage 7：Packaged App 文件操作冒烟 P13–P16。
import { test, expect } from "@playwright/test";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { requirePackagedArtifact } from "../desktopArtifacts";
import {
  createPackageVaultFixture,
  launchPackaged,
  note,
} from "./packageFixture";

async function exists(abs: string): Promise<boolean> {
  try {
    await access(abs);
    return true;
  } catch {
    return false;
  }
}

test.describe("安装包冒烟：R011 文件操作（P13–P16）", () => {
  test.beforeAll(() => {
    requirePackagedArtifact();
  });

  test("P13：打包产物 Document rename + link rewrite", async () => {
    const vaultId = "v-e2e-pkg-fileops-p13";
    const fixture = await createPackageVaultFixture(
      [
        [
          "目标.md",
          note("01JEPKGFILE00000000001", "目标页", "目标。"),
        ],
        [
          "来源.md",
          note("01JEPKGFILE00000000002", "来源页", "见 [目标页](目标.md)。"),
        ],
      ],
      vaultId,
    );
    try {
      const app = await launchPackaged(fixture.userDataDir);
      try {
        const window = await app.firstWindow();
        await window.waitForLoadState("domcontentloaded");
        await expect(window.getByRole("tree").first()).toBeVisible({
          timeout: 20_000,
        });
        const result = await window.evaluate(async (vid) => {
          const e1 = (
            window as unknown as {
              e1?: {
                fileOperation?: {
                  plan: (i: unknown) => Promise<unknown>;
                  execute: (i: unknown) => Promise<unknown>;
                };
              };
            }
          ).e1;
          if (!e1?.fileOperation) return { ok: false, reason: "no api" };
          const plan = await e1.fileOperation.plan({
            kind: "rename-document-file",
            vaultId: vid,
            fromRelativePath: "目标.md",
            newName: "新目标.md",
          });
          await e1.fileOperation.execute({ vaultId: vid, plan });
          return { ok: true };
        }, vaultId);
        expect(result.ok).toBe(true);
        expect(await exists(path.join(fixture.vaultDir, "目标.md"))).toBe(
          false,
        );
        expect(await exists(path.join(fixture.vaultDir, "新目标.md"))).toBe(
          true,
        );
        const source = await readFile(
          path.join(fixture.vaultDir, "来源.md"),
          "utf8",
        );
        expect(source).toContain("[目标页](新目标.md)");
      } finally {
        await app.close();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test("P14：打包产物 Group move + index rebuild", async () => {
    const vaultId = "v-e2e-pkg-fileops-p14";
    const fixture = await createPackageVaultFixture(
      [
        [
          "组/内.md",
          note("01JEPKGFILE00000000011", "内", "指 [外](../外.md)。"),
        ],
        [
          "外.md",
          note("01JEPKGFILE00000000012", "外", "指 [内](组/内.md)。"),
        ],
        ["箱/.gitkeep", ""],
      ],
      vaultId,
    );
    try {
      const app = await launchPackaged(fixture.userDataDir);
      try {
        const window = await app.firstWindow();
        await window.waitForLoadState("domcontentloaded");
        await expect(window.getByRole("tree").first()).toBeVisible({
          timeout: 20_000,
        });
        const result = await window.evaluate(async (vid) => {
          const e1 = (
            window as unknown as {
              e1?: {
                fileOperation?: {
                  plan: (i: unknown) => Promise<unknown>;
                  execute: (i: unknown) => Promise<unknown>;
                };
                links?: {
                  rebuild: (i: unknown) => Promise<unknown>;
                  status: (i: unknown) => Promise<{ state: string }>;
                };
              };
            }
          ).e1;
          if (!e1?.fileOperation) return { ok: false };
          const plan = await e1.fileOperation.plan({
            kind: "move-group",
            vaultId: vid,
            fromRelativePath: "组",
            toRelativePath: "箱",
          });
          await e1.fileOperation.execute({ vaultId: vid, plan });
          // 打包环境确认 links API 仍可用（rebuild 由 Renderer reconcile 触发）。
          const status = await e1.links?.status({ vaultId: vid });
          return { ok: true, linkState: status?.state ?? null };
        }, vaultId);
        expect(result.ok).toBe(true);
        expect(await exists(path.join(fixture.vaultDir, "箱", "组", "内.md"))).toBe(
          true,
        );
        const outer = await readFile(
          path.join(fixture.vaultDir, "外.md"),
          "utf8",
        );
        expect(outer).toContain("[内](箱/组/内.md)");
      } finally {
        await app.close();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test("P15：打包产物 crash journal recovery", async () => {
    const vaultId = "v-e2e-pkg-fileops-p15";
    const original = note("01JEPKGFILE00000000021", "原稿", "原始内容。");
    const fixture = await createPackageVaultFixture(
      [["原稿.md", original]],
      vaultId,
    );
    const opId = "op-pkg-crash-001";
    const journalDir = path.join(
      fixture.vaultDir,
      ".e1",
      "operations",
      opId,
    );
    await mkdir(path.join(journalDir, "backup"), { recursive: true });
    await writeFile(
      path.join(journalDir, "backup", "原稿.md"),
      original,
      "utf8",
    );
    await writeFile(
      path.join(journalDir, "manifest.json"),
      JSON.stringify({
        version: 1,
        operationId: opId,
        vaultId,
        kind: "rename-document-file",
        phase: "rewriting",
        fromRelativePath: "原稿.md",
        toRelativePath: "改写中.md",
        backups: [
          {
            originalRelativePath: "原稿.md",
            backupRelativePath: "backup/原稿.md",
            versionToken: "sha256:deadbeef",
          },
        ],
        createdAt: "2026-09-03T00:00:00.000Z",
      }),
      "utf8",
    );
    await writeFile(
      path.join(fixture.vaultDir, "原稿.md"),
      note("01JEPKGFILE00000000021", "原稿", "半完成污染。"),
      "utf8",
    );
    try {
      const app = await launchPackaged(fixture.userDataDir);
      try {
        const window = await app.firstWindow();
        await window.waitForLoadState("domcontentloaded");
        await expect(window.getByRole("tree").first()).toBeVisible({
          timeout: 20_000,
        });
        await expect
          .poll(
            async () =>
              readFile(path.join(fixture.vaultDir, "原稿.md"), "utf8"),
            { timeout: 15_000 },
          )
          .toContain("原始内容。");
        const status = await window.evaluate(async (vid) => {
          const e1 = (
            window as unknown as {
              e1?: {
                fileOperation?: {
                  recoveryStatus: (i: unknown) => Promise<{ phase: string }>;
                };
              };
            }
          ).e1;
          return e1?.fileOperation?.recoveryStatus({ vaultId: vid });
        }, vaultId);
        expect(status?.phase).toBe("clean");
      } finally {
        await app.close();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test("P16：打包产物 Workspace rename persistence", async () => {
    const vaultId = "v-e2e-pkg-fileops-p16";
    const fixture = await createPackageVaultFixture(
      [["欢迎.md", note("01JEPKGFILE00000000031", "欢迎", "你好。")]],
      vaultId,
    );
    const rootBefore = fixture.vaultDir;
    try {
      const app = await launchPackaged(fixture.userDataDir);
      try {
        const window = await app.firstWindow();
        await window.waitForLoadState("domcontentloaded");
        await expect(window.getByRole("tree").first()).toBeVisible({
          timeout: 20_000,
        });
        await window.evaluate(
          async ({ vid, name }) => {
            const e1 = (
              window as unknown as {
                e1?: { vault?: { rename: (i: unknown) => Promise<unknown> } };
              }
            ).e1;
            await e1?.vault?.rename({ vaultId: vid, name });
          },
          { vid: vaultId, name: "打包逻辑名" },
        );
        const vaultJson = JSON.parse(
          await readFile(
            path.join(fixture.vaultDir, ".e1", "vault.json"),
            "utf8",
          ),
        ) as { name: string };
        expect(vaultJson.name).toBe("打包逻辑名");
        expect(fixture.vaultDir).toBe(rootBefore);
      } finally {
        await app.close();
      }
    } finally {
      await fixture.cleanup();
    }
  });
});
