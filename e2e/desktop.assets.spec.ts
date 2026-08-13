// R006-C5：Desktop 本地附件闭环 E2E（Playwright _electron，生产模式）。
// describe 以「桌面冒烟」为前缀，经 test:e2e:desktop 运行。
import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requireDesktopArtifacts } from "./desktopArtifacts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

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
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "e1-vault-assets-"));
  const vaultName = path.basename(vaultDir);
  for (const [rel, content] of files) {
    const abs = path.join(vaultDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  const vaultId = "v-e2e-assets";
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
    path.join(os.tmpdir(), "e1-userdata-assets-"),
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
  await window.getByLabel("插入").click();
  await window.getByRole("menuitem", { name: item }).click();
}

async function writeTempAsset(name: string, content: Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "e1-pick-"));
  const abs = path.join(dir, name);
  await writeFile(abs, content);
  return abs;
}

test.describe("桌面冒烟：本地附件与资源闭环（R006-C5）", () => {
  test.beforeAll(() => {
    requireDesktopArtifacts();
  });

  test("@golden E2E-01：插入图片 → 保存 → 重启后仍显示，Markdown 为相对路径", async () => {
    const rel = "笔记.md";
    const fixture = await createVaultFixture([
      [
        rel,
        [
          "---",
          "id: 01JE2EASSET000000000001",
          "title: 可插图",
          "---",
          "",
          "正文。",
          "",
        ].join("\n"),
      ],
    ]);
    const source = await writeTempAsset("image.png", PNG);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await window.getByRole("treeitem", { name: /可插图/ }).click();
      await stubFileDialog(app, source);
      await insertFromToolbar(window, "图片");
      await expect(window.locator(".local-image__img")).toBeVisible({
        timeout: 15_000,
      });
      await expect(window.getByText("已保存")).toBeVisible({ timeout: 10_000 });
      expect(
        existsSync(path.join(fixture.vaultDir, "assets", "image.png")),
      ).toBe(true);
      const md = await readFile(path.join(fixture.vaultDir, rel), "utf8");
      expect(md).toMatch(/\]\(assets\/image\.png\)/);
      expect(md).not.toContain("e1-asset:");
      expect(md).not.toContain("blob:");
    } finally {
      await app.close();
    }

    const app2 = await launch(fixture.userDataDir);
    try {
      const window = await app2.firstWindow();
      await window.getByRole("treeitem", { name: /可插图/ }).click();
      await expect(window.locator(".local-image__img")).toBeVisible({
        timeout: 15_000,
      });
      await expect(window.getByText("图片不可用")).toHaveCount(0);
    } finally {
      await app2.close();
      await fixture.cleanup();
    }
  });

  test("E2E-02：插入附件 → 保存 → 重启后恢复 attachment 块", async () => {
    const rel = "笔记.md";
    const fixture = await createVaultFixture([
      [
        rel,
        [
          "---",
          "id: 01JE2EASSET000000000011",
          "title: 可插附件",
          "---",
          "",
          "正文。",
          "",
        ].join("\n"),
      ],
    ]);
    const source = await writeTempAsset("design.pdf", PDF);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await window.getByRole("treeitem", { name: /可插附件/ }).click();
      await stubFileDialog(app, source);
      await insertFromToolbar(window, "附件");
      await expect(window.locator(".attachment-block")).toBeVisible({
        timeout: 15_000,
      });
      await expect(window.getByText("已保存")).toBeVisible({ timeout: 10_000 });
      expect(
        existsSync(path.join(fixture.vaultDir, "assets", "design.pdf")),
      ).toBe(true);
      const md = await readFile(path.join(fixture.vaultDir, rel), "utf8");
      expect(md).toMatch(/\]\(assets\/design\.pdf\)/);
      expect(md).not.toContain("e1-asset:");
    } finally {
      await app.close();
    }

    const app2 = await launch(fixture.userDataDir);
    try {
      const window = await app2.firstWindow();
      await window.getByRole("treeitem", { name: /可插附件/ }).click();
      await expect(window.locator(".attachment-block")).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      await app2.close();
      await fixture.cleanup();
    }
  });

  test("E2E-03：同名连续导入递增且不覆盖", async () => {
    const rel = "笔记.md";
    const fixture = await createVaultFixture([
      [
        rel,
        [
          "---",
          "id: 01JE2EASSET000000000012",
          "title: 同名图",
          "---",
          "",
          "正文。",
          "",
        ].join("\n"),
      ],
    ]);
    const source = await writeTempAsset("image.png", PNG);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await window.getByRole("treeitem", { name: /同名图/ }).click();
      await stubFileDialog(app, source);
      await insertFromToolbar(window, "图片");
      await expect(window.locator(".local-image__img")).toHaveCount(1, {
        timeout: 15_000,
      });
      await insertFromToolbar(window, "图片");
      await expect(window.locator(".local-image__img")).toHaveCount(2, {
        timeout: 15_000,
      });
      await expect(window.getByText("已保存")).toBeVisible({ timeout: 10_000 });
      expect(
        existsSync(path.join(fixture.vaultDir, "assets", "image.png")),
      ).toBe(true);
      expect(
        existsSync(path.join(fixture.vaultDir, "assets", "image (2).png")),
      ).toBe(true);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("E2E-04：仅预览 Vault 导入资源被拒绝，目录不变", async () => {
    const vaultDir = await mkdtemp(path.join(os.tmpdir(), "e1-plain-asset-"));
    await writeFile(
      path.join(vaultDir, "普通笔记.md"),
      "# 普通笔记\n\n正文。\n",
    );
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "e1-userdata-"));
    const app = await launch(userDataDir);
    try {
      const window = await app.firstWindow();
      await app.evaluate(async ({ dialog }, dir) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [dir],
        });
      }, vaultDir);
      await window.getByLabel("打开本地知识库").click();
      await expect(
        window.getByRole("dialog", { name: "打开本地文件夹" }),
      ).toBeVisible();
      await window.getByRole("button", { name: "仅预览" }).click();
      await expect(
        window.getByRole("treeitem", { name: /普通笔记/ }),
      ).toBeVisible();
      await window.getByRole("treeitem", { name: /普通笔记/ }).click();
      await expect(window.locator(".editor__content .ProseMirror")).toBeVisible(
        {
          timeout: 15_000,
        },
      );
      await window.waitForTimeout(800);
      const imported = await window.evaluate(async () => {
        const raw = localStorage.getItem("e1:desktop-preferences");
        const prefs = raw ? (JSON.parse(raw) as { lastRoute?: string }) : {};
        const route = prefs.lastRoute
          ? (JSON.parse(prefs.lastRoute) as { workspaceId?: string })
          : {};
        const vaultId = route.workspaceId;
        if (!vaultId) return { ok: false, code: "NO_VAULT_ID" };
        const e1 = (
          window as unknown as {
            e1: {
              asset: {
                import(input: unknown): Promise<unknown>;
              };
            };
          }
        ).e1;
        try {
          await e1.asset.import({
            vaultId,
            fileName: "a.png",
            mimeType: "image/png",
            source: { kind: "bytes", data: new Uint8Array([1, 2, 3]) },
          });
          return { ok: true, code: "UNEXPECTED_OK" };
        } catch (err) {
          return {
            ok: false,
            code: (err as { code?: string }).code ?? String(err),
          };
        }
      });
      expect(imported.ok).toBe(false);
      expect(imported.code).toBe("VAULT_READ_ONLY");
      expect(existsSync(path.join(vaultDir, ".e1"))).toBe(false);
      expect(existsSync(path.join(vaultDir, "assets"))).toBe(false);
    } finally {
      await app.close();
      await rm(vaultDir, { recursive: true, force: true });
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("E2E-05：缺失资源仍能打开，保存保留 Markdown 引用", async () => {
    const rel = "学习/React.md";
    const fixture = await createVaultFixture([
      [
        rel,
        [
          "---",
          "id: 01JE2EASSET000000000002",
          "title: 缺失图",
          "---",
          "",
          "![Fiber](../assets/missing.png)",
          "",
          "正文。",
          "",
        ].join("\n"),
      ],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await window.getByRole("treeitem", { name: /缺失图/ }).click();
      await expect(window.getByText("图片不可用")).toBeVisible({
        timeout: 15_000,
      });
      const editor = window.locator(".editor__content .ProseMirror");
      await editor.click();
      await editor.pressSequentially("补充。");
      await expect(window.getByText("已保存")).toBeVisible({ timeout: 10_000 });
      const md = await readFile(path.join(fixture.vaultDir, rel), "utf8");
      expect(md).toContain("](../assets/missing.png)");
      expect(md).toContain("补充。");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("E2E-06：删除节点后物理文件仍在", async () => {
    const rel = "笔记.md";
    const fixture = await createVaultFixture([
      [
        rel,
        [
          "---",
          "id: 01JE2EASSET000000000003",
          "title: 可删图",
          "---",
          "",
          "![Fiber](assets/keep.png)",
          "",
        ].join("\n"),
      ],
      ["assets/keep.png", PNG],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await window.getByRole("treeitem", { name: /可删图/ }).click();
      const img = window.locator(".local-image");
      await expect(img).toBeVisible({ timeout: 15_000 });
      await img.click();
      await window.keyboard.press("Backspace");
      await expect(window.getByText("已保存")).toBeVisible({ timeout: 10_000 });
      expect(
        existsSync(path.join(fixture.vaultDir, "assets", "keep.png")),
      ).toBe(true);
      const md = await readFile(path.join(fixture.vaultDir, rel), "utf8");
      expect(md).not.toContain("keep.png");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("E2E-07：嵌套笔记插入图片写出正确相对路径", async () => {
    const rel = "A/B/C.md";
    const fixture = await createVaultFixture([
      [
        rel,
        [
          "---",
          "id: 01JE2EASSET000000000013",
          "title: 嵌套笔记",
          "---",
          "",
          "正文。",
          "",
        ].join("\n"),
      ],
    ]);
    const source = await writeTempAsset("a.png", PNG);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await window.getByRole("treeitem", { name: /嵌套笔记/ }).click();
      await stubFileDialog(app, source);
      await insertFromToolbar(window, "图片");
      await expect(window.locator(".local-image__img")).toBeVisible({
        timeout: 15_000,
      });
      await expect(window.getByText("已保存")).toBeVisible({ timeout: 10_000 });
      const md = await readFile(path.join(fixture.vaultDir, rel), "utf8");
      expect(md).toContain("](../../assets/a.png)");
      expect(md).not.toContain("e1-asset:");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("E2E-08：Portable 导出计入 Desktop 资源", async () => {
    const rel = "学习/React.md";
    const fixture = await createVaultFixture([
      [
        rel,
        [
          "---",
          "id: 01JE2EASSET000000000014",
          "title: 导出笔记",
          "---",
          "",
          "![Fiber](../assets/fiber.png)",
          "",
        ].join("\n"),
      ],
      ["assets/fiber.png", PNG],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await window.getByRole("treeitem", { name: /导出笔记/ }).click();
      await expect(window.locator(".local-image__img")).toBeVisible({
        timeout: 15_000,
      });
      await window.getByLabel("设置").click();
      await expect(window.getByRole("dialog", { name: "设置" })).toBeVisible();
      await window
        .getByRole("button", { name: "导出知识库（.e1.zip）" })
        .click();
      await expect(window.getByText(/已导出 .*1 个附件/)).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });
});
