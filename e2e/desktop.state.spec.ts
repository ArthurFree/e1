// R007 阶段 2：Desktop 设备级交互状态 E2E（Playwright _electron，生产模式）。
// G06/G07 黄金路径：收藏/最近打开写 userData/vault-state/<vaultId>.json，
// 重启保持；Markdown 全程不被修改。
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
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "e1-vault-state-"));
  const vaultName = path.basename(vaultDir);
  for (const [rel, content] of files) {
    const abs = path.join(vaultDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  const vaultId = "v-e2e-state";
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
    path.join(os.tmpdir(), "e1-userdata-state-"),
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

const NOTE_MD = [
  "---",
  "id: 01JE2ESTATE00000000001",
  "title: 状态笔记",
  "---",
  "",
  "正文。",
  "",
].join("\n");

test.describe("桌面冒烟：设备级交互状态（R007 阶段 2）", () => {
  test.beforeAll(() => {
    requireDesktopArtifacts();
  });

  test("@golden G06：收藏文档 → vault-state 落盘（不改 Markdown）→ 重启保持", async () => {
    const rel = "状态笔记.md";
    const fixture = await createVaultFixture([[rel, NOTE_MD]]);
    const stateFile = path.join(
      fixture.userDataDir,
      "vault-state",
      `${fixture.vaultId}.json`,
    );
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await window.getByRole("treeitem", { name: /状态笔记/ }).click();
      await window.getByRole("button", { name: "收藏文档" }).click();
      await expect(
        window.getByRole("button", { name: "取消收藏文档" }),
      ).toBeVisible({ timeout: 10_000 });

      // 落盘：stableNoteId 键带 favoriteAt。
      const state = JSON.parse(await readFile(stateFile, "utf8")) as {
        pages: Record<string, { favoriteAt: number | null }>;
      };
      expect(
        state.pages["01JE2ESTATE00000000001"]?.favoriteAt,
      ).toBeGreaterThan(0);
      // Markdown 不被修改。
      expect(await readFile(path.join(fixture.vaultDir, rel), "utf8")).toBe(
        NOTE_MD,
      );
    } finally {
      await app.close();
    }

    // 重启：「收藏」视图仍列出该文档。
    const app2 = await launch(fixture.userDataDir);
    try {
      const window = await app2.firstWindow();
      await window.getByRole("button", { name: "收藏", exact: true }).click();
      const section = window.locator('[aria-label="收藏的文档"]');
      await expect(
        section.getByText("状态笔记"),
      ).toBeVisible({ timeout: 10_000 });
    } finally {
      await app2.close();
      await fixture.cleanup();
    }
  });

  test("@golden G07：打开文档 → lastOpenedAt 落盘 → 重启后「最近」保持", async () => {
    const rel = "状态笔记.md";
    const fixture = await createVaultFixture([[rel, NOTE_MD]]);
    const stateFile = path.join(
      fixture.userDataDir,
      "vault-state",
      `${fixture.vaultId}.json`,
    );
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await window.getByRole("treeitem", { name: /状态笔记/ }).click();
      // 编辑器渲染完成即触发 markOpened（fire-and-forget）：轮询等落盘。
      await expect(
        window.getByRole("button", { name: "收藏文档" }),
      ).toBeVisible({ timeout: 10_000 });
      await expect
        .poll(
          async () => {
            try {
              const state = JSON.parse(await readFile(stateFile, "utf8")) as {
                pages: Record<string, { lastOpenedAt: number | null }>;
              };
              return state.pages["01JE2ESTATE00000000001"]?.lastOpenedAt ?? 0;
            } catch {
              return 0;
            }
          },
          { timeout: 10_000 },
        )
        .toBeGreaterThan(0);
    } finally {
      await app.close();
    }

    // 重启：「最近」视图仍列出该文档。
    const app2 = await launch(fixture.userDataDir);
    try {
      const window = await app2.firstWindow();
      await window.getByRole("button", { name: "最近", exact: true }).click();
      await expect(
        window.getByText("状态笔记").first(),
      ).toBeVisible({ timeout: 10_000 });
    } finally {
      await app2.close();
      await fixture.cleanup();
    }
  });
});
