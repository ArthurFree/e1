// R009 Stage 3：Packaged App E2E —— P05 搜索 / P06 Watcher。
// describe 以「安装包冒烟」为前缀，独立运行用 npm run test:e2e:package。
// P05 的价值在 packaged 专属：隔离 userData 下搜索索引从零 rebuild，
// 直接验证 asar 内 node:sqlite / FTS5 可用（repo 模式掩盖不了缺依赖）。
// P06 同理验证 asar 内 chokidar 加载与外部变更全链路。
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { requirePackagedArtifact } from "../desktopArtifacts";
import {
  createPackageVaultFixture,
  launchPackaged,
  note,
} from "./packageFixture";

const VAULT_ID = "v-e2e-pkg-search";

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

test.describe("安装包冒烟：搜索与 Watcher（P05/P06）", () => {
  test.beforeAll(() => {
    requirePackagedArtifact();
  });

  test("P05：索引 rebuild 后标题与正文搜索均命中", async () => {
    const fixture = await createPackageVaultFixture(
      [
        [
          "React.md",
          [
            "---",
            "id: 01JE2EPKG0000000000301",
            "title: React 笔记",
            "tags: [前端]",
            "---",
            "",
            "组件化与 Hooks 要点。",
            "",
          ].join("\n"),
        ],
        ["随想.md", "今天研究了 search indexing 的中文分词方案。\n"],
      ],
      VAULT_ID,
    );
    const app = await launchPackaged(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      // 隔离 userData → 索引库不存在 → 自动 rebuild（packaged 下 node:sqlite）。
      await waitIndexReady(window);

      // 标题命中。
      let dialog = await search(window, "React");
      await expect(dialog.getByText("React 笔记")).toBeVisible();
      await closeSearch(window);

      // 正文命中（中文 bigram，标题无此词）。
      dialog = await search(window, "分词");
      await expect(dialog.getByText("随想")).toBeVisible();
      await closeSearch(window);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("P06：外部写 .md → UI 自动感知（自动重载 + 轻量提示条）", async () => {
    const rel = "看门狗.md";
    const fixture = await createPackageVaultFixture(
      [[rel, note("01JE2EPKG0000000000302", "看门狗笔记", "修改前正文。")]],
      "v-e2e-pkg-watcher",
    );
    const abs = path.join(fixture.vaultDir, rel);
    const app = await launchPackaged(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await window.getByRole("treeitem", { name: /看门狗笔记/ }).click();
      const editor = window.locator(".editor__content .ProseMirror");
      await expect(editor).toContainText("修改前正文。", { timeout: 15_000 });
      // 树渲染 + 文档打开后稍等 watcher 就绪（chokidar 初始扫描事件会被吞）。
      await window.waitForTimeout(800);

      await writeFile(
        abs,
        note("01JE2EPKG0000000000302", "看门狗笔记", "外部程序改写后的正文。"),
        "utf8",
      );

      // clean 文档自动重载 + 轻量提示条（asar 内 chokidar 全链路）。
      await expect(editor).toContainText("外部程序改写后的正文。", {
        timeout: 15_000,
      });
      await expect(
        window
          .locator('[role="status"]')
          .getByText("文件已由其他程序更新，已自动重新载入。"),
      ).toBeVisible({ timeout: 15_000 });
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });
});
