// R007 阶段 1：Desktop 文档元数据写入 E2E（Playwright _electron，生产模式）。
// G04/G05 黄金路径：标题/标签写回 Frontmatter，重启后保持；正文不受影响。
// describe 以「桌面冒烟」为前缀：默认 test:e2e 经 --grep-invert 排除。
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requireDesktopArtifacts } from "./desktopArtifacts";

interface VaultFixture {
  vaultDir: string;
  userDataDir: string;
  vaultId: string;
  cleanup(): Promise<void>;
}

async function createVaultFixture(
  files: Array<[string, string]>,
): Promise<VaultFixture> {
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "e1-vault-meta-"));
  const vaultName = path.basename(vaultDir);
  for (const [rel, content] of files) {
    const abs = path.join(vaultDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  const vaultId = "v-e2e-metadata";
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
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "e1-userdata-meta-"));
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

const NOTE_MD = [
  "---",
  "id: 01JE2EMETA000000000001",
  "title: 可改标题",
  "---",
  "",
  "正文。",
  "",
].join("\n");

test.describe("桌面冒烟：文档元数据写入（R007 阶段 1）", () => {
  test.beforeAll(() => {
    requireDesktopArtifacts();
  });

  test("@golden G04：行内重命名标题 → 写回 Frontmatter → 重启保持", async () => {
    const rel = "笔记.md";
    const fixture = await createVaultFixture([[rel, NOTE_MD]]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      // 不打开文档，直接从页面树行内重命名。
      await window.getByRole("treeitem", { name: /可改标题/ }).hover();
      await window
        .getByRole("button", { name: "重命名「可改标题」" })
        .click();
      const input = window.getByRole("textbox", { name: "重命名" });
      await input.fill("新标题");
      await input.press("Enter");
      await expect(
        window.getByRole("treeitem", { name: /新标题/ }),
      ).toBeVisible({ timeout: 10_000 });

      // 磁盘：Frontmatter title 更新，id 与正文逐字节保留。
      const md = await readFile(path.join(fixture.vaultDir, rel), "utf8");
      expect(md).toContain("title: 新标题");
      expect(md).toContain("id: 01JE2EMETA000000000001");
      expect(md).toContain("正文。");
    } finally {
      await app.close();
    }

    // 重启：扫描读到新标题，旧标题消失。
    const app2 = await launch(fixture.userDataDir);
    try {
      const window = await app2.firstWindow();
      await expect(
        window.getByRole("treeitem", { name: /新标题/ }),
      ).toBeVisible({ timeout: 10_000 });
      await expect(
        window.getByRole("treeitem", { name: /可改标题/ }),
      ).toHaveCount(0);
    } finally {
      await app2.close();
      await fixture.cleanup();
    }
  });

  test("@golden G05：新建标签并勾选 → 写回 Frontmatter tags → 重启保持", async () => {
    const rel = "笔记.md";
    const fixture = await createVaultFixture([[rel, NOTE_MD]]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await window.getByRole("treeitem", { name: /可改标题/ }).click();
      await window.getByRole("button", { name: "添加标签" }).click();
      const input = window.getByRole("textbox", { name: "新建标签名称" });
      await input.fill("学习");
      await input.press("Enter");
      await expect(
        window.locator(".tag-chip", { hasText: "学习" }).first(),
      ).toBeVisible({ timeout: 10_000 });

      // 磁盘：Frontmatter tags 写回，正文不动。
      const md = await readFile(path.join(fixture.vaultDir, rel), "utf8");
      expect(md).toContain("tags: [学习]");
      expect(md).toContain("正文。");
    } finally {
      await app.close();
    }

    // 重启：重新打开文档，标签 chip 仍在。
    const app2 = await launch(fixture.userDataDir);
    try {
      const window = await app2.firstWindow();
      await window.getByRole("treeitem", { name: /可改标题/ }).click();
      await expect(
        window.locator(".tag-chip", { hasText: "学习" }).first(),
      ).toBeVisible({ timeout: 10_000 });
    } finally {
      await app2.close();
      await fixture.cleanup();
    }
  });
});
