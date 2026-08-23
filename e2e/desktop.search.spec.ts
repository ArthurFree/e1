// R008 Stage 5（§12/§14）：Desktop 全文搜索 E2E（Playwright _electron，
// 生产模式）。describe 以「桌面冒烟」为前缀：默认 test:e2e 经
// --grep-invert 排除，独立运行用 npm run test:e2e:desktop。
//
// @golden G14 title 搜索 / G15 body 搜索 / G16 中文正文搜索：
// 打开 Vault 自动建索引（§11.5 prepare）→ 全局搜索面板检索。
// @golden G17 外部编辑 → watcher → 新正文可搜索；
// @golden G18 外部删除 → 搜索结果消失。
import { test, expect, _electron as electron } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  appendFile,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requireDesktopArtifacts } from "./desktopArtifacts";

const VAULT_ID = "v-e2e-search";

interface SearchFixture {
  vaultDir: string;
  userDataDir: string;
  cleanup(): Promise<void>;
}

async function createFixture(): Promise<SearchFixture> {
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "e1-vault-search-"));
  const vaultName = path.basename(vaultDir);
  await mkdir(path.join(vaultDir, ".e1"));
  await writeFile(
    path.join(vaultDir, ".e1", "vault.json"),
    JSON.stringify({
      format: "e1-vault",
      formatVersion: 1,
      vaultId: VAULT_ID,
      name: vaultName,
      createdAt: "2026-08-10T00:00:00.000Z",
      assetsDirectory: "assets",
      identityMode: "frontmatter",
    }),
  );
  await mkdir(path.join(vaultDir, "学习"));
  await writeFile(
    path.join(vaultDir, "学习", "React.md"),
    [
      "---",
      "id: 01JE2ESEARCH00000000001",
      "title: React 笔记",
      "tags: [前端]",
      "---",
      "",
      "组件化与 Hooks 要点。",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(vaultDir, "随想.md"),
    "今天研究了 search indexing 的中文分词方案。\n",
  );
  const userDataDir = await mkdtemp(
    path.join(os.tmpdir(), "e1-userdata-search-"),
  );
  await writeFile(
    path.join(userDataDir, "recent-vaults.json"),
    JSON.stringify([
      {
        vaultId: VAULT_ID,
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

/** 等全文索引 ready（打开 Vault 自动 prepare → rebuild）。 */
async function waitIndexReady(window: Page) {
  await expect
    .poll(
      async () =>
        window.evaluate(async (vaultId) => {
          const e1 = (
            window as unknown as {
              e1?: {
                search?: {
                  status(input: {
                    vaultId: string;
                  }): Promise<{ state: string }>;
                };
              };
            }
          ).e1;
          return (await e1?.search?.status({ vaultId }))?.state ?? null;
        }, VAULT_ID),
      { timeout: 15_000 },
    )
    .toBe("ready");
}

async function search(window: Page, query: string) {
  await window.getByLabel("搜索").click();
  const input = window.getByLabel("搜索文档");
  await input.fill(query);
  // 搜索经防抖 + IPC：给结果留出到达时间。
  await window.waitForTimeout(800);
  return window.getByRole("dialog", { name: "全局搜索" });
}

async function closeSearch(window: Page) {
  await window.keyboard.press("Escape");
  await expect(
    window.getByRole("dialog", { name: "全局搜索" }),
  ).not.toBeVisible();
}

test.describe("桌面冒烟：全文搜索（R008 Stage 5）", () => {
  test.beforeAll(() => {
    requireDesktopArtifacts();
  });

  test("@golden G14/G15/G16：title / body / 中文正文搜索", async () => {
    const fixture = await createFixture();
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitIndexReady(window);

      // G14：title 命中。
      let dialog = await search(window, "React");
      await expect(dialog.getByText("React 笔记")).toBeVisible();
      await closeSearch(window);

      // G15：body 命中（拉丁词，标题无）。
      dialog = await search(window, "indexing");
      await expect(dialog.getByText("随想")).toBeVisible();
      await closeSearch(window);

      // G16：中文正文命中（bigram 覆盖）。
      dialog = await search(window, "分词");
      await expect(dialog.getByText("随想")).toBeVisible();
      await closeSearch(window);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G17：外部编辑文档 → watcher → 新正文可搜索", async () => {
    const fixture = await createFixture();
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitIndexReady(window);
      // 外部程序写入新内容。
      await appendFile(
        path.join(fixture.vaultDir, "随想.md"),
        "\n补充：孔雀东南飞，五里一徘徊。\n",
      );
      // watcher → reconciler → 索引 upsert：先等索引反映变更（IPC 层断言）。
      await expect
        .poll(
          async () =>
            window.evaluate(async (vaultId) => {
              const e1 = (
                window as unknown as {
                  e1?: {
                    search?: {
                      query(input: {
                        vaultId: string;
                        query: string;
                      }): Promise<unknown[]>;
                    };
                  };
                }
              ).e1;
              const rows = await e1?.search?.query({
                vaultId,
                query: "孔雀",
              });
              return rows?.length ?? 0;
            }, VAULT_ID),
          { timeout: 15_000 },
        )
        .toBeGreaterThan(0);
      // UI 搜索面板同样可见。
      const dialog = await search(window, "孔雀");
      await expect(dialog.getByText("随想")).toBeVisible({
        timeout: 10_000,
      });
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G18：外部删除 → 搜索结果消失", async () => {
    const fixture = await createFixture();
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitIndexReady(window);
      let dialog = await search(window, "分词");
      await expect(dialog.getByText("随想")).toBeVisible();
      await closeSearch(window);
      // 外部删除文件。
      await unlink(path.join(fixture.vaultDir, "随想.md"));
      await expect
        .poll(
          async () => {
            await window.getByLabel("搜索").click();
            const input = window.getByLabel("搜索文档");
            await input.fill("分词");
            await window.waitForTimeout(800);
            const visible = await window
              .getByRole("dialog", { name: "全局搜索" })
              .getByText("随想")
              .count();
            await window.keyboard.press("Escape");
            return visible;
          },
          { timeout: 10_000 },
        )
        .toBe(0);
      dialog = await search(window, "分词");
      await expect(dialog.getByText("随想")).toHaveCount(0);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });
});

test.describe("桌面冒烟：搜索索引恢复（R008 Stage 6）", () => {
  test.beforeAll(() => {
    requireDesktopArtifacts();
  });

  test("@golden G20：删除 search DB → 重启 → 自动 rebuild，搜索恢复", async () => {
    const fixture = await createFixture();
    const app1 = await launch(fixture.userDataDir);
    try {
      const window = await app1.firstWindow();
      await waitIndexReady(window);
      const dialog = await search(window, "分词");
      await expect(dialog.getByText("随想")).toBeVisible();
    } finally {
      await app1.close();
    }

    // 删除派生索引库（Markdown 不动）。
    await rm(path.join(fixture.userDataDir, "search-index"), {
      recursive: true,
      force: true,
    });

    const app2 = await launch(fixture.userDataDir);
    try {
      const window = await app2.firstWindow();
      // 自动 prepare：missing → building → ready（§13.2/§13.3 恢复通道）。
      await waitIndexReady(window);
      const dialog = await search(window, "分词");
      await expect(dialog.getByText("随想")).toBeVisible();
    } finally {
      await app2.close();
      await fixture.cleanup();
    }
  });
});
