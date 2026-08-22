// R008 Stage 2（§9，G3）：Desktop Reveal in File Manager E2E
//（Playwright _electron，生产模式）。describe 以「桌面冒烟」为前缀：
// 默认 test:e2e 经 --grep-invert 排除，独立运行用 npm run test:e2e:desktop。
//
// @golden G12：当前文档 → 顶栏「在文件管理器中显示」→ 真实 IPC 成功（无错误条）。
// @golden G13：附件节点「在文件夹中显示」→ 真实 IPC 成功（无「无法定位文件」）。
// shell.showItemInFolder 的 GUI 效果不可断言（CI xvfb 无文件管理器），
// 此处验证的是 §17.4 口径：capability/UI 入口 + IPC 全链路 + Main 真实路径解析；
// 路径拒绝/逃逸/缺失（REVEAL_TARGET_NOT_FOUND）由 Main 单元测试覆盖。
import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requireDesktopArtifacts } from "./desktopArtifacts";

const PDF = Buffer.from("%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

interface VaultFixture {
  vaultDir: string;
  userDataDir: string;
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
      createdAt: "2026-08-10T00:00:00.000Z",
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
        lastOpenedAt: "2026-08-10T00:00:00.000Z",
      },
    ]),
  );
  return {
    vaultDir,
    userDataDir,
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

async function stubFileDialog(
  app: ElectronApplication,
  filePath: string,
): Promise<void> {
  await app.evaluate(async ({ dialog }, target) => {
    dialog.showOpenDialog = async (opts) => {
      const properties = opts?.properties ?? [];
      if (properties.includes("openDirectory")) {
        return { canceled: true, filePaths: [] };
      }
      return { canceled: false, filePaths: [target] };
    };
  }, filePath);
}

async function insertFromToolbar(window: Page, item: "图片" | "附件") {
  await window.getByRole("button", { name: "插入", exact: true }).click();
  await window.getByRole("menuitem", { name: item }).click();
}

test.describe("桌面冒烟：Reveal in File Manager（R008 Stage 2）", () => {
  test.beforeAll(() => {
    requireDesktopArtifacts();
  });

  test("@golden G12：当前文档 → 顶栏「在文件管理器中显示」→ IPC 成功", async () => {
    const fixture = await createVaultFixture([
      [
        "笔记.md",
        [
          "---",
          "id: 01JE2EREVEAL00000000001",
          "title: 笔记",
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
      await window.getByRole("treeitem", { name: /笔记/ }).click();
      await expect(window.locator(".editor__content")).toContainText("正文。");
      // capability/UI：revealInFileManager=true → 顶栏入口可见。
      const reveal = window.getByRole("button", {
        name: "在文件管理器中显示",
      });
      await expect(reveal).toBeVisible();
      await reveal.click();
      // 真实 IPC（schema → 注册表 → PathGuard → shell）成功：无错误条。
      await window.waitForTimeout(500);
      await expect(window.locator(".recovery-banner")).toHaveCount(0);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G13：附件节点「在文件夹中显示」→ IPC 成功", async () => {
    const fixture = await createVaultFixture([
      [
        "笔记.md",
        [
          "---",
          "id: 01JE2EREVEAL00000000002",
          "title: 可插图",
          "---",
          "",
          "正文。",
          "",
        ].join("\n"),
      ],
    ]);
    const pickDir = await mkdtemp(path.join(os.tmpdir(), "e1-reveal-pick-"));
    const source = path.join(pickDir, "说明书.pdf");
    await writeFile(source, PDF);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await window.getByRole("treeitem", { name: /可插图/ }).click();
      await stubFileDialog(app, source);
      await insertFromToolbar(window, "附件");
      const block = window.locator(".attachment-block");
      await expect(block).toBeVisible({ timeout: 15_000 });
      const reveal = window.getByRole("button", {
        name: /在文件夹中显示附件/,
      });
      await expect(reveal).toBeVisible();
      await reveal.click();
      // asset.reveal 成功：节点不出现「无法定位文件」。
      await window.waitForTimeout(500);
      await expect(
        window.locator(".attachment-block__status"),
      ).not.toContainText("无法定位文件");
    } finally {
      await app.close();
      await fixture.cleanup();
      await rm(pickDir, { recursive: true, force: true });
    }
  });
});
