// R008 Stage 2（§9，G3）：Desktop Reveal in File Manager E2E
//（Playwright _electron，生产模式）。describe 以「桌面冒烟」为前缀：
// 默认 test:e2e 经 --grep-invert 排除，独立运行用 npm run test:e2e:desktop。
//
// @golden G12：当前文档 → 顶栏「在文件管理器中显示」→ 真实 IPC 成功（无错误条）。
// @golden G13：附件节点「在文件夹中显示」→ 真实 IPC 成功（无「无法定位文件」）。
//
// R009 Stage 0.2（§3.3）：Linux CI（xvfb headless）没有文件管理器，
// 真实 shell.showItemInFolder 会挂起 30s 超时。因此 E2E 统一经
// E1_REVEAL_STUB=1 让 Main 用记录型 stub 替换真实 shell（见 main.ts），
// 断言「UI 点击 → preload → IPC → Main handler → PathGuard」全链路：
// stub 日志（userData/e2e-reveal-stub.log）必须记录解析后的绝对路径，
// 且 UI 无错误。真实 OS shell 集成不进 Linux headless golden test，
// macOS/Windows 手动验收口径：桌面端打开 Vault → 顶栏/附件节点点击
// 「在文件管理器中显示」→ Finder/资源管理器弹出并选中目标文件。
// 路径拒绝/逃逸/缺失（REVEAL_TARGET_NOT_FOUND）由 Main 单元测试覆盖。
import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
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
    env: {
      ...process.env,
      E1_USER_DATA_DIR: userDataDir,
      // R009 Stage 0.2：Main 用记录型 stub 替换真实 shell.showItemInFolder，
      // 避免 Linux headless 下真实调用挂起；stub 日志见 expectRevealLogged。
      E1_REVEAL_STUB: "1",
    },
  });
}

/**
 * 断言 E1_REVEAL_STUB 记录日志最终包含目标绝对路径——
 * 证明 UI 点击 → preload → IPC → Main handler → PathGuard 全链路走通。
 */
async function expectRevealLogged(userDataDir: string, targetPath: string) {
  const logPath = path.join(userDataDir, "e2e-reveal-stub.log");
  await expect
    .poll(async () => {
      try {
        return await readFile(logPath, "utf8");
      } catch {
        return "";
      }
    })
    .toContain(targetPath);
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
      // IPC（schema → 注册表 → PathGuard → stub shell）成功：
      // stub 记录解析后的绝对路径（macOS /tmp 符号链接需 realpath 对齐），无错误条。
      await expectRevealLogged(
        fixture.userDataDir,
        path.join(await realpath(fixture.vaultDir), "笔记.md"),
      );
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
      // asset.reveal 成功：stub 记录导入后的 Vault 内资源路径
      //（sanitize 保留中文名与扩展名，首个导入无冲突 → assets/说明书.pdf），
      // 节点不出现「无法定位文件」。
      await expectRevealLogged(
        fixture.userDataDir,
        path.join(await realpath(fixture.vaultDir), "assets", "说明书.pdf"),
      );
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
