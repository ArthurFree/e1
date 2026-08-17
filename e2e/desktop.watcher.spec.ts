// R007 阶段 3：External Change Watcher E2E（Playwright _electron，生产模式）。
// 覆盖验收 1–7（docs/requirements/R007-desktop-local-vault-productization.md §阶段 3）：
//   1. 外部写 clean 文档 → 自动刷新 + 轻量提示；
//   2. dirty + 外部写 → 冲突面板，本地内容不被覆盖；
//   3. 外部新增 .md → 页面树出现；
//   4. 外部删除 .md → 页面树消失 + 打开中 clean 文档出「源文件已被删除」错误块；
//   5. 外部 rename 带 stable-id 文件 → 同一 pageId，树中仍一项、标题随新文件；
//   6. E1 autosave → 自写抑制，不出现外部更新提示条（无 reload loop）；
//   7. 快速连改 20 次 → coalescing 后最终内容正确（弱断言，合并次数见
//      DesktopExternalVaultChangeService.test.ts / WatchEventCoalescer 单测）。
// 外部写直接对 vaultDir 用 node fs（测试进程与 app 进程同机）。
// 链路延迟：chokidar awaitWriteFinish 200ms + 合并窗口 + Renderer 200ms 静止窗口
// + 重扫，断言一律 expect.poll / 带超时 expect（10–15s）。
// describe 以「桌面冒烟」为前缀：默认 test:e2e 经 --grep-invert 排除，
// 独立运行用 npm run test:e2e:desktop。
import { test, expect, _electron as electron } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
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
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "e1-vault-watch-"));
  const vaultName = path.basename(vaultDir);
  for (const [rel, content] of files) {
    const abs = path.join(vaultDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  const vaultId = "v-e2e-watcher";
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
    path.join(os.tmpdir(), "e1-userdata-watch-"),
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

function note(id: string, title: string, body: string): string {
  return ["---", `id: ${id}`, `title: ${title}`, "---", "", body, ""].join(
    "\n",
  );
}

const RELOAD_NOTICE = "文件已由其他程序更新，已自动重新载入。";
/** 树渲染 + 文档打开后稍等 watcher 就绪（chokidar 初始扫描期间的事件会被吞）。 */
const WATCHER_READY_MS = 800;
/** 外部变更全链路（watcher → coalescer → renderer 静止窗口 → 重扫）断言超时。 */
const WATCH_TIMEOUT = 15_000;

test.describe("桌面冒烟：External Change Watcher（R007 阶段 3）", () => {
  test.beforeAll(() => {
    requireDesktopArtifacts();
  });

  test("验收1：外部修改 clean 文档 → 自动刷新 + 轻量提示条", async () => {
    const rel = "看门狗.md";
    const fixture = await createVaultFixture([
      [rel, note("01JE2EWATCH00000000001", "看门狗笔记", "修改前正文。")],
    ]);
    const abs = path.join(fixture.vaultDir, rel);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await window.getByRole("treeitem", { name: /看门狗笔记/ }).click();
      const editor = window.locator(".editor__content .ProseMirror");
      await expect(editor).toContainText("修改前正文。");
      await window.waitForTimeout(WATCHER_READY_MS);

      await writeFile(
        abs,
        note("01JE2EWATCH00000000001", "看门狗笔记", "外部程序改写后的正文。"),
        "utf8",
      );

      // 自动重载：编辑器内容与轻量提示条（role=status，约 5 秒自动消失）。
      await expect(editor).toContainText("外部程序改写后的正文。", {
        timeout: WATCH_TIMEOUT,
      });
      await expect(
        window.locator('[role="status"]').getByText(RELOAD_NOTICE),
      ).toBeVisible({ timeout: WATCH_TIMEOUT });
      // 无冲突面板。
      await expect(window.locator(".conflict-banner")).toHaveCount(0);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("验收2：dirty + 外部写 → 冲突面板，本地内容不被覆盖", async () => {
    const rel = "冲突.md";
    const fixture = await createVaultFixture([
      [rel, note("01JE2EWATCH00000000002", "冲突笔记", "E1 内初始。")],
    ]);
    const abs = path.join(fixture.vaultDir, rel);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await window.getByRole("treeitem", { name: /冲突笔记/ }).click();
      const editor = window.locator(".editor__content .ProseMirror");
      await expect(editor).toContainText("E1 内初始。");
      await window.waitForTimeout(WATCHER_READY_MS);
      await editor.click();
      await window.keyboard.type("本地未保存编辑。");
      await expect(window.getByText("有未保存更改")).toBeVisible();

      // dirty 窗口内外部程序改写磁盘（watcher 事件到达时本地仍 dirty）。
      await writeFile(
        abs,
        note("01JE2EWATCH00000000002", "冲突笔记", "外部程序写入。"),
        "utf8",
      );

      await expect(
        window.getByText(
          "这篇笔记已在 E1 之外发生修改，为了避免覆盖外部修改，自动保存已暂停。",
        ),
      ).toBeVisible({ timeout: WATCH_TIMEOUT });
      await expect(
        window.getByRole("button", { name: "重新载入" }),
      ).toBeVisible();
      await expect(
        window.getByRole("button", { name: "强制覆盖" }),
      ).toBeVisible();
      // 本地内容不被覆盖：编辑器仍是本地文本，磁盘仍是外部文本。
      await expect(editor).toContainText("本地未保存编辑。");
      expect(await readFile(abs, "utf8")).toContain("外部程序写入。");
      expect(await readFile(abs, "utf8")).not.toContain("本地未保存编辑。");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("验收3：外部新增 .md → 页面树出现", async () => {
    const fixture = await createVaultFixture([
      ["已有.md", note("01JE2EWATCH00000000003", "已有笔记", "已有正文。")],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await expect(
        window.getByRole("treeitem", { name: /已有笔记/ }),
      ).toBeVisible({ timeout: WATCH_TIMEOUT });
      await window.waitForTimeout(WATCHER_READY_MS);

      await writeFile(
        path.join(fixture.vaultDir, "新增.md"),
        note("01JE2EWATCH00000000004", "外部新增笔记", "新增正文。"),
        "utf8",
      );

      await expect(
        window.getByRole("treeitem", { name: /外部新增笔记/ }),
      ).toBeVisible({ timeout: WATCH_TIMEOUT });
      // 新条目可打开，内容与磁盘一致。
      await window.getByRole("treeitem", { name: /外部新增笔记/ }).click();
      await expect(
        window.locator(".editor__content .ProseMirror"),
      ).toContainText("新增正文。");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("验收4：外部删除打开中的 clean 文档 → 树消失 + 「源文件已被删除」错误块", async () => {
    const rel = "待删.md";
    const fixture = await createVaultFixture([
      [rel, note("01JE2EWATCH00000000005", "待删笔记", "待删正文。")],
      ["保留.md", note("01JE2EWATCH00000000006", "保留笔记", "保留正文。")],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await window.getByRole("treeitem", { name: /待删笔记/ }).click();
      const editor = window.locator(".editor__content .ProseMirror");
      await expect(editor).toContainText("待删正文。");
      await window.waitForTimeout(WATCHER_READY_MS);

      await rm(path.join(fixture.vaultDir, rel));

      // 页面树中消失，保留项不受影响。
      await expect(
        window.getByRole("treeitem", { name: /待删笔记/ }),
      ).toHaveCount(0, { timeout: WATCH_TIMEOUT });
      await expect(
        window.getByRole("treeitem", { name: /保留笔记/ }),
      ).toBeVisible();
      // 正文区替换为「源文件已被删除」错误块（content-error）。
      const errorBlock = window.locator(".content-error");
      await expect(errorBlock.getByText("源文件已被删除")).toBeVisible({
        timeout: WATCH_TIMEOUT,
      });
      await expect(
        errorBlock.getByRole("button", { name: "重新扫描知识库" }),
      ).toBeVisible();
      await expect(
        errorBlock.getByRole("button", { name: "返回知识库" }),
      ).toBeVisible();
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("验收4-dirty：外部删除时本地 dirty → 提示条保留内存内容", async () => {
    const rel = "脏删.md";
    const fixture = await createVaultFixture([
      [rel, note("01JE2EWATCH00000000010", "脏删笔记", "脏删初始。")],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await window.getByRole("treeitem", { name: /脏删笔记/ }).click();
      const editor = window.locator(".editor__content .ProseMirror");
      await expect(editor).toContainText("脏删初始。");
      await window.waitForTimeout(WATCHER_READY_MS);
      await editor.click();
      await window.keyboard.type("本地未保存编辑。");
      await expect(window.getByText("有未保存更改")).toBeVisible();

      // dirty 窗口内外部删除源文件。
      await rm(path.join(fixture.vaultDir, rel));

      // 提示条：内容保留在内存中，提供另存副本/复制出口。
      await expect(
        window.getByText(
          "源文件已被其他程序删除，当前编辑内容仍保留在内存中。",
        ),
      ).toBeVisible({ timeout: WATCH_TIMEOUT });
      await expect(
        window.getByRole("button", { name: "另存副本" }),
      ).toBeVisible();
      await expect(
        window.getByRole("button", { name: "复制当前内容" }),
      ).toBeVisible();
      // 编辑器内本地文本仍在（未被清空、未出现 clean 错误块）。
      await expect(editor).toContainText("本地未保存编辑。");
      await expect(window.locator(".content-error")).toHaveCount(0);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("验收4-复苏：clean 删除后外部重建同 stable-id 文件 → 错误块消失并自动重载", async () => {
    const rel = "复苏.md";
    const id = "01JE2EWATCH00000000011";
    const fixture = await createVaultFixture([
      [rel, note(id, "复苏笔记", "复苏前正文。")],
    ]);
    const abs = path.join(fixture.vaultDir, rel);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await window.getByRole("treeitem", { name: /复苏笔记/ }).click();
      const editor = window.locator(".editor__content .ProseMirror");
      await expect(editor).toContainText("复苏前正文。");
      await window.waitForTimeout(WATCHER_READY_MS);

      await rm(abs);
      const errorBlock = window.locator(".content-error");
      await expect(errorBlock.getByText("源文件已被删除")).toBeVisible({
        timeout: WATCH_TIMEOUT,
      });

      // 外部程序以同一 stable id 重建该文件。
      await writeFile(abs, note(id, "复苏笔记", "外部重建后的正文。"), "utf8");

      // 错误块消失、自动重载提示出现、编辑器显示新内容，树条目恢复。
      await expect(errorBlock).toHaveCount(0, { timeout: WATCH_TIMEOUT });
      await expect(editor).toContainText("外部重建后的正文。", {
        timeout: WATCH_TIMEOUT,
      });
      await expect(
        window.locator('[role="status"]').getByText(RELOAD_NOTICE),
      ).toBeVisible({ timeout: WATCH_TIMEOUT });
      await expect(
        window.getByRole("treeitem", { name: /复苏笔记/ }),
      ).toHaveCount(1);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("验收5：外部 rename 带 stable-id 文件 → 同一 pageId，树中仍一项且标题随新文件", async () => {
    const fixture = await createVaultFixture([
      [
        "重命名前.md",
        note("01JE2EWATCH00000000007", "重命名前标题", "改名正文。"),
      ],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      const before = window.getByRole("treeitem", { name: /重命名前标题/ });
      await expect(before).toHaveCount(1, { timeout: WATCH_TIMEOUT });
      await window.waitForTimeout(WATCHER_READY_MS);

      // 模拟外部编辑器「写新文件 + 删旧文件」式改名：新路径同 stable id。
      await rename(
        path.join(fixture.vaultDir, "重命名前.md"),
        path.join(fixture.vaultDir, "重命名后.md"),
      );
      await writeFile(
        path.join(fixture.vaultDir, "重命名后.md"),
        note("01JE2EWATCH00000000007", "重命名后标题", "改名正文。"),
        "utf8",
      );

      // 同一 pageId：树中仍只有一项，标题随新文件，不重复不消失。
      const after = window.getByRole("treeitem", { name: /重命名后标题/ });
      await expect(after).toHaveCount(1, { timeout: WATCH_TIMEOUT });
      await expect(before).toHaveCount(0, { timeout: WATCH_TIMEOUT });
      // 仍可按新标题打开同一文档。
      await after.click();
      await expect(
        window.locator(".editor__content .ProseMirror"),
      ).toContainText("改名正文。");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("验收6：E1 自己 autosave → 自写抑制，不出现外部更新提示条", async () => {
    const rel = "自写.md";
    const fixture = await createVaultFixture([
      [rel, note("01JE2EWATCH00000000008", "自写笔记", "自写初始。")],
    ]);
    const abs = path.join(fixture.vaultDir, rel);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await window.getByRole("treeitem", { name: /自写笔记/ }).click();
      const editor = window.locator(".editor__content .ProseMirror");
      await expect(editor).toContainText("自写初始。");
      await window.waitForTimeout(WATCHER_READY_MS);
      await editor.click();
      await window.keyboard.type("自动保存写入。");
      await expect(window.getByText(/已保存/)).toBeVisible({ timeout: 5000 });
      await expect
        .poll(async () => readFile(abs, "utf8"))
        .toContain("自动保存写入。");

      // 等待足够覆盖 watcher + coalescer + renderer 静止窗口全程，
      // 确认 autosave 回声被抑制：无 reload loop 提示条。
      await window.waitForTimeout(3000);
      await expect(window.getByText(RELOAD_NOTICE)).toHaveCount(0);
      // 内容也未被重载覆盖。
      await expect(editor).toContainText("自动保存写入。");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("验收7：快速连改 20 次 → coalescing 后最终内容正确", async () => {
    const rel = "连改.md";
    const fixture = await createVaultFixture([
      [rel, note("01JE2EWATCH00000000009", "连改笔记", "连改初始。")],
    ]);
    const abs = path.join(fixture.vaultDir, rel);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await window.getByRole("treeitem", { name: /连改笔记/ }).click();
      const editor = window.locator(".editor__content .ProseMirror");
      await expect(editor).toContainText("连改初始。");
      await window.waitForTimeout(WATCHER_READY_MS);

      // 短时间写入 20 个文件事件（同文件连续覆盖）。
      for (let i = 1; i <= 20; i += 1) {
        await writeFile(
          abs,
          note("01JE2EWATCH00000000009", "连改笔记", `第 ${i} 次外部写入。`),
          "utf8",
        );
      }

      // 弱断言：合并/重扫后页面树与文档最终一致。
      await expect(editor).toContainText("第 20 次外部写入。", {
        timeout: WATCH_TIMEOUT,
      });
      await expect(
        window.getByRole("treeitem", { name: /连改笔记/ }),
      ).toHaveCount(1);
      expect(await readFile(abs, "utf8")).toContain("第 20 次外部写入。");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });
});
