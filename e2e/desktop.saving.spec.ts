// R006-C4-H：Desktop Markdown 创建与安全保存 E2E（Playwright _electron，生产模式）。
// describe 以「桌面冒烟」为前缀：默认 test:e2e 经 --grep-invert 排除，
// 独立运行用 npm run test:e2e:desktop。
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

async function createVaultFixture(
  files: Array<[string, string]>,
  options: { initialized?: boolean; vaultId?: string } = {},
): Promise<VaultFixture> {
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "e1-vault-save-"));
  const vaultName = path.basename(vaultDir);
  for (const [rel, content] of files) {
    const abs = path.join(vaultDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  const vaultId = options.vaultId ?? "v-e2e-saving";
  if (options.initialized !== false) {
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
  }
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "e1-userdata-save-"));
  if (options.initialized !== false) {
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
  }
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

async function sha256Of(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

test.describe("桌面冒烟：Markdown 创建与安全保存（R006-C4）", () => {
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

  test("自动保存：编辑后 800ms 内写盘，内容与 hash 更新", async () => {
    const rel = "学习/React.md";
    const fixture = await createVaultFixture([
      [
        rel,
        [
          "---",
          "id: 01JE2ESAVE0000000000001",
          "title: React 笔记",
          "---",
          "",
          "原始正文。",
          "",
        ].join("\n"),
      ],
    ]);
    const abs = path.join(fixture.vaultDir, rel);
    const hashBefore = await sha256Of(abs);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await window.getByRole("treeitem", { name: /React 笔记/ }).click();
      const editor = window.locator(".editor__content .ProseMirror");
      await expect(editor).toContainText("原始正文。");
      await editor.click();
      await window.keyboard.type("自动保存写入。");
      await expect(window.getByText("有未保存更改")).toBeVisible();
      await expect(window.getByText(/已保存/)).toBeVisible({ timeout: 5000 });
      await expect
        .poll(async () => readFile(abs, "utf8"))
        .toContain("自动保存写入。");
      expect(await sha256Of(abs)).not.toBe(hashBefore);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("外部修改冲突：磁盘保留外部内容；强制覆盖可成功", async () => {
    const rel = "冲突.md";
    const fixture = await createVaultFixture([
      [
        rel,
        [
          "---",
          "id: 01JE2ECONFLICT000000001",
          "title: 冲突笔记",
          "---",
          "",
          "E1 内初始。",
          "",
        ].join("\n"),
      ],
    ]);
    const abs = path.join(fixture.vaultDir, rel);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await window.getByRole("treeitem", { name: /冲突笔记/ }).click();
      const editor = window.locator(".editor__content .ProseMirror");
      await expect(editor).toContainText("E1 内初始。");
      await editor.click();
      await window.keyboard.type("本地未保存编辑。");
      await expect(window.getByText("有未保存更改")).toBeVisible();

      // 外部程序改写磁盘（在自动保存前）。
      await writeFile(
        abs,
        [
          "---",
          "id: 01JE2ECONFLICT000000001",
          "title: 冲突笔记",
          "---",
          "",
          "外部程序写入。",
          "",
        ].join("\n"),
        "utf8",
      );

      // 等待自动保存撞冲突。
      await expect(
        window.getByText(/已在 E1 之外发生修改|与外部修改冲突/),
      ).toBeVisible({ timeout: 8000 });
      expect(await readFile(abs, "utf8")).toContain("外部程序写入。");
      expect(await readFile(abs, "utf8")).not.toContain("本地未保存编辑。");

      await window.getByRole("button", { name: "强制覆盖" }).click();
      await expect(window.getByText(/已保存/)).toBeVisible({ timeout: 5000 });
      await expect
        .poll(async () => readFile(abs, "utf8"))
        .toContain("本地未保存编辑。");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("Stable ID Adoption：启用编辑后首次保存写入 Frontmatter id", async () => {
    const rel = "随笔.md";
    const original = "# 随笔\n\n无稳定 id 的正文。\n";
    const fixture = await createVaultFixture([[rel, original]]);
    const abs = path.join(fixture.vaultDir, rel);
    const hashBefore = await sha256Of(abs);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await window.getByRole("treeitem", { name: /随笔/ }).click();
      await expect(
        window.getByText(/尚未建立 E1 稳定笔记身份/),
      ).toBeVisible();
      const editor = window.locator(".editor__content .ProseMirror");
      await expect(editor).toHaveAttribute("contenteditable", "false");
      // 阅读本身不写 id。
      expect(await sha256Of(abs)).toBe(hashBefore);

      await window.getByRole("button", { name: "启用编辑" }).click();
      await expect(editor).toHaveAttribute("contenteditable", "true");
      await editor.click();
      await window.keyboard.type(" Adoption 后编辑。");
      await expect(window.getByText(/已保存/)).toBeVisible({ timeout: 5000 });
      const after = await readFile(abs, "utf8");
      expect(after).toMatch(/^---\n[\s\S]*id: /m);
      expect(after).toContain("Adoption 后编辑。");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("Adoption 后重新扫描：当前文档仍打开且树仍选中（C4.1 E2E-01）", async () => {
    const rel = "随笔.md";
    const fixture = await createVaultFixture([
      [rel, "# 随笔\n\n无稳定 id 的正文。\n"],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      const treeItem = window.getByRole("treeitem", { name: /随笔/ });
      await treeItem.click();
      await window.getByRole("button", { name: "启用编辑" }).click();
      const editor = window.locator(".editor__content .ProseMirror");
      await expect(editor).toHaveAttribute("contenteditable", "true");
      await editor.click();
      await window.keyboard.type(" 扫描前编辑。");
      await expect(window.getByText(/已保存/)).toBeVisible({ timeout: 5000 });

      await window.getByRole("button", { name: "首页" }).click();
      await window.getByRole("button", { name: "重新扫描" }).click();
      await expect(treeItem).toHaveAttribute("aria-selected", "true");
      await treeItem.click();
      await expect(editor).toHaveAttribute("contenteditable", "true");
      await expect(window.getByRole("button", { name: "启用编辑" })).toHaveCount(
        0,
      );
      await editor.click();
      await window.keyboard.type(" 扫描后继续。");
      await expect(window.getByText(/已保存/)).toBeVisible({ timeout: 5000 });
      const abs = path.join(fixture.vaultDir, rel);
      await expect.poll(async () => readFile(abs, "utf8")).toContain("扫描后继续。");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("重启后页面树身份升级为磁盘 stable id，仍一篇（C4.1 E2E-02）", async () => {
    const rel = "随笔.md";
    const fixture = await createVaultFixture([
      [rel, "# 随笔\n\n无稳定 id 的正文。\n"],
    ]);
    const abs = path.join(fixture.vaultDir, rel);
    const app1 = await launch(fixture.userDataDir);
    try {
      const window = await app1.firstWindow();
      await window.getByRole("treeitem", { name: /随笔/ }).click();
      await window.getByRole("button", { name: "启用编辑" }).click();
      const editor = window.locator(".editor__content .ProseMirror");
      await editor.click();
      await window.keyboard.type(" 首次保存。");
      await expect(window.getByText(/已保存/)).toBeVisible({ timeout: 5000 });
      const disk = await readFile(abs, "utf8");
      expect(disk).toMatch(/^---\n[\s\S]*id: /m);
    } finally {
      await app1.close();
    }

    const app2 = await launch(fixture.userDataDir);
    try {
      const window = await app2.firstWindow();
      const items = window.getByRole("treeitem", { name: /随笔/ });
      await expect(items).toHaveCount(1);
      await items.click();
      await expect(window.getByRole("button", { name: "启用编辑" })).toHaveCount(
        0,
      );
      const editor = window.locator(".editor__content .ProseMirror");
      await expect(editor).toHaveAttribute("contenteditable", "true");
      await expect(editor).toContainText("首次保存。");
    } finally {
      await app2.close();
      await fixture.cleanup();
    }
  });

  test("新建文档：生成带 id 的 Markdown 文件", async () => {
    const fixture = await createVaultFixture([
      [
        "README.md",
        [
          "---",
          "id: 01JE2EREADME00000000001",
          "title: README",
          "---",
          "",
          "已存在。",
          "",
        ].join("\n"),
      ],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await window.getByRole("button", { name: "新建文档" }).click();
      await expect(window.locator(".editor__content .ProseMirror")).toBeVisible({
        timeout: 5000,
      });
      await expect
        .poll(async () => existsSync(path.join(fixture.vaultDir, "无标题.md")))
        .toBe(true);
      const created = await readFile(
        path.join(fixture.vaultDir, "无标题.md"),
        "utf8",
      );
      expect(created).toMatch(/^---\n[\s\S]*id: /m);
      expect(created).toContain("title:");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("Frontmatter 未知字段 / CRLF 往返：保存后保留", async () => {
    const rel = "crlf.md";
    const body = [
      "---",
      "id: 01JE2ECRLF0000000000001",
      "title: CRLF",
      "custom_field: keep-me",
      "tags: [a]",
      "---",
      "",
      "CRLF 正文。",
      "",
    ].join("\r\n");
    const fixture = await createVaultFixture([[rel, body]]);
    const abs = path.join(fixture.vaultDir, rel);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await window.getByRole("treeitem", { name: /CRLF/ }).click();
      const editor = window.locator(".editor__content .ProseMirror");
      await expect(editor).toContainText("CRLF 正文。");
      await editor.click();
      await window.keyboard.type("追加。");
      await expect(window.getByText(/已保存/)).toBeVisible({ timeout: 5000 });
      const after = await readFile(abs);
      const text = after.toString("utf8");
      expect(text).toContain("custom_field: keep-me");
      expect(text.includes("\r\n")).toBe(true);
      expect(text).toContain("追加。");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });
});
