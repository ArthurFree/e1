// R011 Stage 7：Packaged App 文件操作冒烟 P13–P16。
// R11C-08：P14 必须真断言 LinkIndex/SearchIndex（ready + 新路径 + 全文命中），
// 不允许只读回状态不 expect。
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
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

/**
 * R11C-08：links/search 组 IPC 弱类型桥（形状以 shared/ipc/contracts.ts
 * E1DesktopAPI 为准，此处只声明断言用到的字段子集；API 缺失时返回
 * null/[]，随后的 expect 会红而不是静默跳过）。
 */
interface PackageIndexBridge {
  links?: {
    status(input: { vaultId: string }): Promise<{ state: string }>;
    rebuild(input: { vaultId: string }): Promise<unknown>;
    outgoing(input: {
      vaultId: string;
      noteKey: string;
    }): Promise<Array<{ targetRelativePath: string | null; broken: boolean }>>;
    backlinks(input: {
      vaultId: string;
      noteKey: string;
    }): Promise<Array<{ sourcePageId: string; href: string }>>;
  };
  search?: {
    status(input: { vaultId: string }): Promise<{ state: string }>;
    rebuild(input: { vaultId: string }): Promise<unknown>;
    query(input: {
      vaultId?: string;
      query: string;
    }): Promise<Array<{ relativePath: string; stableNoteId: string | null }>>;
  };
}

/** links.status 的 state（API 缺失为 null）。 */
function linkStateOf(window: Page, vaultId: string) {
  return window.evaluate(async (vid) => {
    const e1 = (window as unknown as { e1?: PackageIndexBridge }).e1;
    return (await e1?.links?.status({ vaultId: vid }))?.state ?? null;
  }, vaultId);
}

/** search.status 的 state（API 缺失为 null）。 */
function searchStateOf(window: Page, vaultId: string) {
  return window.evaluate(async (vid) => {
    const e1 = (window as unknown as { e1?: PackageIndexBridge }).e1;
    return (await e1?.search?.status({ vaultId: vid }))?.state ?? null;
  }, vaultId);
}

test.describe("安装包冒烟：R011 文件操作（P13–P16）", () => {
  test.beforeAll(() => {
    requirePackagedArtifact();
  });

  test("P13：打包产物 Document rename + link rewrite", async () => {
    const vaultId = "v-e2e-pkg-fileops-p13";
    const fixture = await createPackageVaultFixture(
      [
        ["目标.md", note("01JEPKGFILE00000000001", "目标页", "目标。")],
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
    const innerId = "01JEPKGFILE00000000011";
    const outerId = "01JEPKGFILE00000000012";
    const fixture = await createPackageVaultFixture(
      [
        ["组/内.md", note(innerId, "内", "组内孤本词，指 [外](../外.md)。")],
        ["外.md", note(outerId, "外", "指 [内](组/内.md)。")],
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
        // R11C-08：LinkIndex/SearchIndex 状态必须 expect 为 ready
        //（打开 Vault 自动 prepare → rebuild；也保证后续 plan 能发现 inbound 影响）。
        await expect
          .poll(() => linkStateOf(window, vaultId), { timeout: 20_000 })
          .toBe("ready");
        await expect
          .poll(() => searchStateOf(window, vaultId), { timeout: 20_000 })
          .toBe("ready");

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
          if (!e1?.fileOperation) return { ok: false };
          const plan = await e1.fileOperation.plan({
            kind: "move-group",
            vaultId: vid,
            fromRelativePath: "组",
            toRelativePath: "箱",
          });
          await e1.fileOperation.execute({ vaultId: vid, plan });
          return { ok: true };
        }, vaultId);
        expect(result.ok).toBe(true);
        expect(
          await exists(path.join(fixture.vaultDir, "箱", "组", "内.md")),
        ).toBe(true);
        const outer = await readFile(
          path.join(fixture.vaultDir, "外.md"),
          "utf8",
        );
        expect(outer).toContain("[内](箱/组/内.md)");

        // IPC 直调跳过 Renderer reconcile（同 G35 口径）：显式 rebuild 双索引，
        // 同时验证打包产物内 node:sqlite 索引链路可用。
        await window.evaluate(async (vid) => {
          const e1 = (window as unknown as { e1?: PackageIndexBridge }).e1;
          await e1?.links?.rebuild({ vaultId: vid });
          await e1?.search?.rebuild({ vaultId: vid });
        }, vaultId);
        await expect
          .poll(() => linkStateOf(window, vaultId), { timeout: 20_000 })
          .toBe("ready");
        await expect
          .poll(() => searchStateOf(window, vaultId), { timeout: 20_000 })
          .toBe("ready");

        // R11C-08：LinkIndex 功能断言——move 后 外.md 的出边指向新路径，
        // 内.md 的反向链接 href 同样是新路径。
        const outgoing = await window.evaluate(
          async ({ vid, key }) => {
            const e1 = (window as unknown as { e1?: PackageIndexBridge }).e1;
            return (
              (await e1?.links?.outgoing({ vaultId: vid, noteKey: key })) ?? []
            );
          },
          { vid: vaultId, key: outerId },
        );
        expect(
          outgoing.some(
            (link) =>
              link.targetRelativePath === "箱/组/内.md" &&
              link.broken === false,
          ),
        ).toBe(true);
        const backlinks = await window.evaluate(
          async ({ vid, key }) => {
            const e1 = (window as unknown as { e1?: PackageIndexBridge }).e1;
            return (
              (await e1?.links?.backlinks({ vaultId: vid, noteKey: key })) ?? []
            );
          },
          { vid: vaultId, key: innerId },
        );
        expect(
          backlinks.some(
            (backlink) =>
              backlink.sourcePageId === outerId &&
              backlink.href === "箱/组/内.md",
          ),
        ).toBe(true);

        // R11C-08：SearchIndex 功能断言——内.md 正文独特词全文命中，
        // 且命中行已更新为搬迁后的新路径与稳定 id。
        const hits = await window.evaluate(
          async ({ vid, query }) => {
            const e1 = (window as unknown as { e1?: PackageIndexBridge }).e1;
            return (await e1?.search?.query({ vaultId: vid, query })) ?? [];
          },
          { vid: vaultId, query: "组内孤本词" },
        );
        expect(
          hits.some(
            (hit) =>
              hit.stableNoteId === innerId &&
              hit.relativePath === "箱/组/内.md",
          ),
        ).toBe(true);
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
    const journalDir = path.join(fixture.vaultDir, ".e1", "operations", opId);
    await mkdir(path.join(journalDir, "backup"), { recursive: true });
    await writeFile(
      path.join(journalDir, "backup", "原稿.md"),
      original,
      "utf8",
    );
    await writeFile(
      path.join(journalDir, "manifest.json"),
      JSON.stringify({
        version: 2,
        operationId: opId,
        vaultId,
        kind: "rename-document-file",
        phase: "rewriting",
        backups: [
          {
            originalRelativePath: "原稿.md",
            backupRelativePath: "backup/原稿.md",
            versionToken: "sha256:deadbeef",
          },
        ],
        pathSteps: [
          {
            id: "step-0",
            kind: "document",
            fromRelativePath: "原稿.md",
            toRelativePath: "改写中.md",
            hopRelativePath: null,
            state: "pending",
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
