// R008 Stage 2（§9/§17.4）：Reveal in File Manager E2E（Playwright _electron，
// 生产模式）。describe 以「桌面冒烟」为前缀，经 test:e2e:desktop 运行。
// CI/Linux 无法验证真实 GUI 文件管理器（§17.4）：经 electron evaluate stub
// shell.showItemInFolder，断言 IPC 全链路被调用且路径在 Vault 内；
// 真实 GUI 行为留平台人工验收。
import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requireDesktopArtifacts } from "./desktopArtifacts";

const PDF = Buffer.from("%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

interface VaultFixture {
  vaultDir: string;
  userDataDir: string;
  vaultId: string;
  cleanup(): Promise<void>;
}

async function createVaultFixture(
  files: Array<[string, string | Buffer]>,
): Promise<VaultFixture> {
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "e1-vault-reveal-"));
  const vaultName = path.basename(vaultDir);
  for (const [rel, content] of files) {
    const abs = path.join(vaultDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  const vaultId = "v-e2e-reveal";
  await mkdir(path.join(vaultDir, ".e1"));
  await writeFile(
    path.join(vaultDir, ".e1", "vault.json"),
    JSON.stringify({
      format: "e1-vault",
      formatVersion: 1,
      vaultId,
      name: vaultName,
      createdAt: "2026-08-21T00:00:00.000Z",
      assetsDirectory: "assets",
      identityMode: "frontmatter",
    }),
  );
  const userDataDir = await mkdtemp(
    path.join(os.tmpdir(), "e1-userdata-reveal-"),
  );
  await writeFile(
    path.join(userDataDir, "recent-vaults.json"),
    JSON.stringify([
      {
        vaultId,
        absolutePath: vaultDir,
        displayName: vaultName,
        lastOpenedAt: "2026-08-21T00:00:00.000Z",
      },
    ]),
  );
  return {
    vaultDir,
    userDataDir,
    vaultId,
    async cleanup() {
      await rm(vaultDir, { recursive: true, force: true });
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}

function launch(userDataDir: string) {
  return electron.launch({
    args: ["."],
    env: { ...process.env, E1_USER_DATA_DIR: userDataDir },
  });
}

/**
 * stub Main 进程的 shell.showItemInFolder：调用记录进 globalThis
 * （真实文件管理器在 CI/Linux 不可验证，§17.4）。
 */
async function stubShellReveal(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ shell }) => {
    const g = globalThis as unknown as { __revealCalls: string[] };
    g.__revealCalls = [];
    shell.showItemInFolder = (fullPath: string) => {
      g.__revealCalls.push(fullPath);
    };
  });
}

async function revealCalls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    () =>
      (globalThis as unknown as { __revealCalls?: string[] }).__revealCalls ??
      [],
  );
}

test.describe("桌面冒烟：在文件管理器中显示（R008 Stage 2）", () => {
  test.beforeAll(() => {
    requireDesktopArtifacts();
  });

  test("G12：当前文档 → 顶栏「在文件管理器中显示」→ shell 收到 Vault 内路径", async () => {
    const rel = "学习/笔记.md";
    const fixture = await createVaultFixture([
      [
        rel,
        [
          "---",
          "id: 01JE2EREVEAL00000000001",
          "title: 可定位",
          "---",
          "",
          "正文。",
          "",
        ].join("\n"),
      ],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await stubShellReveal(app);
      await window.getByRole("treeitem", { name: /可定位/ }).click();
      await expect(window.locator(".editor__content .ProseMirror")).toBeVisible(
        { timeout: 15_000 },
      );

      await window
        .getByRole("button", { name: "在文件管理器中显示", exact: true })
        .click();
      await expect
        .poll(async () => (await revealCalls(app)).length, { timeout: 5_000 })
        .toBe(1);
      const calls = await revealCalls(app);
      // Main 侧经 PathGuard realpath 解析（macOS /tmp → /private/tmp）——
      // 路径必须在 Vault 内且指向目标文件。
      const vaultReal = await realpath(fixture.vaultDir);
      expect(calls[0]).toBe(path.join(vaultReal, "学习", "笔记.md"));
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("G13：附件块「定位」→ shell 收到 assets 内附件路径", async () => {
    const rel = "笔记.md";
    const fixture = await createVaultFixture([
      [
        rel,
        [
          "---",
          "id: 01JE2EREVEAL00000000002",
          "title: 附件定位",
          "---",
          "",
          "[design.pdf](assets/design.pdf)",
          "",
        ].join("\n"),
      ],
      ["assets/design.pdf", PDF],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await stubShellReveal(app);
      await window.getByRole("treeitem", { name: /附件定位/ }).click();
      await expect(window.locator(".attachment-block")).toBeVisible({
        timeout: 15_000,
      });

      await window
        .getByRole("button", { name: "在文件管理器中显示附件 design.pdf" })
        .click();
      await expect
        .poll(async () => (await revealCalls(app)).length, { timeout: 5_000 })
        .toBe(1);
      const calls = await revealCalls(app);
      const vaultReal = await realpath(fixture.vaultDir);
      expect(calls[0]).toBe(path.join(vaultReal, "assets", "design.pdf"));
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });
});
