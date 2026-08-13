// R006-C3 §43：Desktop Markdown 安全阅读 E2E（Playwright _electron，生产模式）。
// 以生产模式启动 Electron（加载 dist/desktop.html），需先运行
// npm run build:desktop 产出 dist/ 与 dist-electron/（缺产物自动 skip）。
// describe 以「桌面冒烟」为前缀：默认 test:e2e 经 --grep-invert 排除，
// 独立运行用 npm run test:e2e:desktop（--grep "桌面冒烟"）。
// 用例（§43）：E2E-01 正常阅读 / E2E-02 unsupported 只读保护 /
// E2E-03 阅读不修改文件（hash 前后一致，本阶段最高优先级验收）/
// E2E-04 普通目录仅预览（不创建 .e1/ 与 assets/）。
import { test, expect, _electron as electron } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface VaultFixture {
  vaultDir: string;
  userDataDir: string;
  vaultId: string;
  cleanup(): Promise<void>;
}

/**
 * 预置「已初始化 Vault + 隔离 userData」：.e1/vault.json 模拟已初始化，
 * recent-vaults.json 模拟已登记（原生目录选择器无法被 Playwright 驱动，
 * 与 desktop.smoke.spec.ts 全链路用例同一模式）。
 */
async function createVaultFixture(
  files: Array<[string, string]>,
): Promise<VaultFixture> {
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "e1-vault-"));
  const vaultName = path.basename(vaultDir);
  for (const [rel, content] of files) {
    const abs = path.join(vaultDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  const vaultId = "v-e2e-reading";
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
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "e1-userdata-"));
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
    vaultId,
    async cleanup() {
      await rm(vaultDir, { recursive: true, force: true });
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}

/** 以隔离的临时 userData 启动应用。 */
function launch(userDataDir: string) {
  return electron.launch({
    args: ["."],
    env: { ...process.env, E1_USER_DATA_DIR: userDataDir },
  });
}

/** 文件内容的 sha256（E2E-03 阅读不修改文件的判定依据）。 */
async function sha256Of(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

test.describe("桌面冒烟：Markdown 安全阅读（R006-C3 §43）", () => {
  test.beforeAll(() => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const artifacts = [
      "dist/desktop.html",
      "dist-electron/main.mjs",
      "dist-electron/preload.cjs",
    ];
    test.skip(
      artifacts.some((p) => !existsSync(path.join(root, p))),
      "缺少 dist/ 或 dist-electron/ 产物，请先运行 npm run build:desktop",
    );
  });

  test("E2E-01 正常 Markdown 阅读：打开 Vault → 点击文档 → 正文可见", async () => {
    const fixture = await createVaultFixture([
      ["README.md", "# 欢迎使用\n\n这是 README 正文。\n"],
      [
        "学习/React.md",
        [
          "---",
          "id: 01JE2EREADING0000000001",
          "title: React 笔记",
          "---",
          "",
          "# React 笔记",
          "",
          "组件化与 Hooks 要点。",
          "",
        ].join("\n"),
      ],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      const doc = window.getByRole("treeitem", { name: /React 笔记/ });
      await expect(doc).toBeVisible();
      await doc.click();
      // note.read → MarkdownCodec → Tiptap：真实正文渲染。
      await expect(window.locator(".editor__content")).toContainText(
        "组件化与 Hooks 要点。",
      );
      await expect(window.locator(".topbar__title")).toHaveText("React 笔记");
      // C4-E：documentPersistence=true → 真实保存状态（非技术验证模式）。
      await expect(window.getByText("已保存")).toBeVisible();
      await expect(
        window.getByText("技术验证模式 · 当前修改不会写回磁盘"),
      ).toHaveCount(0);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("E2E-02 unsupported 保护：只读警告 → 编辑器不可输入 → 允许后可输入", async () => {
    const fixture = await createVaultFixture([
      [
        "学习/unsupported.md",
        [
          "[[Wiki Link]]",
          "",
          '<div custom-attribute="x">',
          "HTML",
          "</div>",
          "",
          "普通段落文本。",
          "",
        ].join("\n"),
      ],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      const doc = window.getByRole("treeitem", { name: /unsupported/ });
      await expect(doc).toBeVisible();
      await doc.click();
      // FR-19/20：lossy → 兼容性警告条 + 默认只读。
      await expect(window.getByText(/暂不完全支持的格式/)).toBeVisible();
      const editor = window.locator(".editor__content .ProseMirror");
      await expect(editor).toContainText("普通段落文本。");
      await expect(editor).toHaveAttribute("contenteditable", "false");
      // FR-20 §28.2：允许本次编辑（仅当前会话）后可输入。
      await window.getByRole("button", { name: "允许本次编辑" }).click();
      await expect(editor).toHaveAttribute("contenteditable", "true");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("E2E-03 阅读不修改文件：打开/切换/关闭前后 hash 全等", async () => {
    // 10 篇 Markdown + vault.json 全部记录 hash（PR-02：阅读绝不产生写入）。
    const files: Array<[string, string]> = [];
    for (let i = 1; i <= 10; i += 1) {
      files.push([
        `笔记${String(i).padStart(2, "0")}.md`,
        `# 笔记${i}\n\n第 ${i} 篇的正文内容。\n`,
      ]);
    }
    const fixture = await createVaultFixture(files);
    const targets = [...files.map(([rel]) => rel), ".e1/vault.json"];
    const hashBefore = new Map<string, string>();
    for (const rel of targets) {
      hashBefore.set(rel, await sha256Of(path.join(fixture.vaultDir, rel)));
    }

    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      // 逐篇打开（含来回切换）：每篇都走 note.read 真实读取。
      for (let i = 1; i <= 10; i += 1) {
        const doc = window.getByRole("treeitem", {
          name: new RegExp(`笔记${String(i).padStart(2, "0")}`),
        });
        await expect(doc).toBeVisible();
        await doc.click();
        await expect(window.locator(".editor__content")).toContainText(
          `第 ${i} 篇的正文内容。`,
        );
      }
      // 来回切换一次，覆盖「切换文档」路径。
      await window.getByRole("treeitem", { name: /笔记01/ }).click();
      await expect(window.locator(".editor__content")).toContainText(
        "第 1 篇的正文内容。",
      );
    } finally {
      // 正常关闭应用（窗口销毁 → 进程退出）后再比对 hash。
      await app.close();
    }

    for (const rel of targets) {
      expect(await sha256Of(path.join(fixture.vaultDir, rel)), rel).toBe(
        hashBefore.get(rel),
      );
    }
    await fixture.cleanup();
  });

  test("E2E-04 普通目录仅预览：树可见且不创建 .e1/ 与 assets/", async () => {
    // 未初始化的普通 Markdown 文件夹（无 .e1/）。
    const vaultDir = await mkdtemp(path.join(os.tmpdir(), "e1-plain-"));
    await mkdir(path.join(vaultDir, "子目录"), { recursive: true });
    await writeFile(
      path.join(vaultDir, "普通笔记.md"),
      "# 普通笔记\n\n正文。\n",
    );
    await writeFile(
      path.join(vaultDir, "子目录", "另一篇.md"),
      "# 另一篇\n\n正文。\n",
    );
    // 空 userData：无最近 Vault，从「打开本地知识库」入口进入。
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "e1-userdata-"));

    const app = await launch(userDataDir);
    try {
      const window = await app.firstWindow();
      // 原生目录选择器无法被 Playwright 驱动：在主进程把
      // dialog.showOpenDialog stub 为选中测试目录（handler 仍走真实
      // 令牌签发 → readVault → 未初始化路径）。
      await app.evaluate(async ({ dialog }, dir) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [dir],
        });
      }, vaultDir);

      await window.getByLabel("打开本地知识库").click();
      // FR-03 三选项确认框。
      await expect(
        window.getByRole("dialog", { name: "打开本地文件夹" }),
      ).toBeVisible();
      await window.getByRole("button", { name: "仅预览" }).click();

      // transient（仅预览）会话：文件树可见、可打开阅读。
      await expect(
        window.getByRole("treeitem", { name: /普通笔记/ }),
      ).toBeVisible();
      await expect(
        window.getByRole("treeitem", { name: /另一篇/ }),
      ).toBeVisible();
      // 仅预览不创建任何 Vault 结构（FR-03 §10.2 / PR-01）。
      expect(existsSync(path.join(vaultDir, ".e1"))).toBe(false);
      expect(existsSync(path.join(vaultDir, "assets"))).toBe(false);
    } finally {
      await app.close();
      await rm(vaultDir, { recursive: true, force: true });
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
});
