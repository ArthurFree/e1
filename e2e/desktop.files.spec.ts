// R007 阶段 4：文件操作闭环 E2E（Playwright _electron，生产模式）。
// 覆盖验收（docs/requirements/R007-desktop-local-vault-productization.md §阶段 4）：
//   G08 @golden：删除 → 回收站（.e1/trash/<opId>/payload/）→ 恢复到原路径，
//        stable note id 不变，页面树消失/重现；
//   新建分组 → 落真实目录；
//   移动文档到目录 → 物理路径正确、stable id 不变。
// 断言磁盘状态直接用 node fs（测试进程与 app 进程同机）。
// describe 以「桌面冒烟」为前缀：默认 test:e2e 经 --grep-invert 排除，
// 独立运行用 npm run test:e2e:desktop。
import { test, expect, _electron as electron } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
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
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "e1-vault-files-"));
  const vaultName = path.basename(vaultDir);
  for (const [rel, content] of files) {
    const abs = path.join(vaultDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  const vaultId = "v-e2e-files";
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
    path.join(os.tmpdir(), "e1-userdata-files-"),
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

/** 回收站目录（.e1/trash）快照：opId → payload 内相对路径列表。 */
async function trashPayloads(vaultDir: string): Promise<string[]> {
  const trashRoot = path.join(vaultDir, ".e1", "trash");
  const opIds = await readdir(trashRoot).catch(() => [] as string[]);
  const payloads: string[] = [];
  for (const opId of opIds) {
    const payloadDir = path.join(trashRoot, opId, "payload");
    const names = await readdir(payloadDir).catch(() => [] as string[]);
    payloads.push(...names.map((name) => `${opId}/${name}`));
  }
  return payloads;
}

const UI_TIMEOUT = 10_000;

test.describe("桌面冒烟：文件操作闭环（R007 阶段 4）", () => {
  test.beforeAll(() => {
    requireDesktopArtifacts();
  });

  test("@golden G08：删除 → 回收站 → 恢复到原路径，stable id 不变", async () => {
    const rel = "待删.md";
    const noteId = "01JE2EFILES000000000001";
    const fixture = await createVaultFixture([
      [rel, note(noteId, "待删笔记", "待删正文。")],
      ["保留.md", note("01JE2EFILES000000000002", "保留笔记", "保留正文。")],
    ]);
    const abs = path.join(fixture.vaultDir, rel);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      const tree = window.getByRole("tree", { name: "页面树" });
      await expect(tree).toContainText("待删笔记", { timeout: UI_TIMEOUT });

      // 删除：rename 进 .e1/trash（非 unlink），树中消失、保留项不受影响。
      await tree.getByText("待删笔记").hover();
      await window.getByLabel("删除「待删笔记」").click();
      await expect(tree).not.toContainText("待删笔记", {
        timeout: UI_TIMEOUT,
      });
      await expect(tree).toContainText("保留笔记");
      await expect
        .poll(async () => trashPayloads(fixture.vaultDir), {
          timeout: UI_TIMEOUT,
        })
        .toHaveLength(1);
      const [payload] = await trashPayloads(fixture.vaultDir);
      expect(payload.endsWith("/待删.md")).toBe(true);
      await expect(stat(abs)).rejects.toThrow();

      // 回收站面板可见条目（条目标题取原文件名——TrashEntry 契约不含
      // Frontmatter 标题；恢复后树中标题仍以 Frontmatter 为准）。
      await window.getByLabel("回收站", { exact: true }).click();
      const trashPanel = window.getByRole("dialog", { name: "回收站" });
      await expect(trashPanel).toContainText("待删");
      await trashPanel.getByText("待删", { exact: true }).hover();
      await trashPanel.getByLabel("恢复「待删」").click();
      await expect(trashPanel.getByText("回收站是空的。")).toBeVisible({
        timeout: UI_TIMEOUT,
      });
      await expect
        .poll(async () => readFile(abs, "utf8").catch(() => null), {
          timeout: UI_TIMEOUT,
        })
        .toContain("待删正文。");
      // stable note id 不变（纯 rename，Frontmatter 不动）。
      expect(await readFile(abs, "utf8")).toContain(`id: ${noteId}`);
      // 回收站清空，页面树重新出现该笔记。
      await expect
        .poll(async () => trashPayloads(fixture.vaultDir))
        .toHaveLength(0);
      await window.keyboard.press("Escape");
      await expect(tree).toContainText("待删笔记", { timeout: UI_TIMEOUT });
      // 恢复后的文档可正常打开。
      await tree.getByText("待删笔记").click();
      await expect(
        window.locator(".editor__content .ProseMirror"),
      ).toContainText("待删正文。");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("新建分组落真实目录", async () => {
    const fixture = await createVaultFixture([
      ["已有.md", note("01JE2EFILES000000000003", "已有笔记", "已有正文。")],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      const tree = window.getByRole("tree", { name: "页面树" });
      await expect(tree).toContainText("已有笔记", { timeout: UI_TIMEOUT });

      await window.getByRole("button", { name: "新建分组" }).click();
      // R008 Stage 0（§7.3）：Desktop 不支持 group.rename，新建分组后
      // 不再自动进入必然失败的重命名流程，直接断言落盘结果。
      await expect(tree).toContainText("新建分组", { timeout: UI_TIMEOUT });
      await expect
        .poll(
          async () =>
            (await stat(path.join(fixture.vaultDir, "新建分组")).catch(
              () => null,
            ))?.isDirectory() ?? false,
          { timeout: UI_TIMEOUT },
        )
        .toBe(true);
      // 未发起重命名，不得出现操作错误条（R008 §7.3）。
      await expect(window.locator(".tree-sidebar__error")).toHaveCount(0);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("拖拽移动文档到目录：物理路径正确、stable id 不变", async () => {
    const noteId = "01JE2EFILES000000000004";
    const fixture = await createVaultFixture([
      ["学习/占位.md", note("01JE2EFILES000000000005", "占位笔记", "占位。")],
      ["根笔记.md", note(noteId, "根笔记", "根目录正文。")],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      const tree = window.getByRole("tree", { name: "页面树" });
      await expect(tree).toContainText("根笔记", { timeout: UI_TIMEOUT });

      // 拖到分组行中部（落点分区：作为其子级）。
      await window
        .getByRole("treeitem", { name: /根笔记/ })
        .dragTo(window.getByRole("treeitem", { name: /学习/ }));

      await expect
        .poll(
          async () =>
            (await stat(
              path.join(fixture.vaultDir, "学习", "根笔记.md"),
            ).catch(() => null))?.isFile() ?? false,
          { timeout: UI_TIMEOUT },
        )
        .toBe(true);
      await expect(
        stat(path.join(fixture.vaultDir, "根笔记.md")),
      ).rejects.toThrow();
      // stable note id 不变（纯 rename）。
      expect(
        await readFile(path.join(fixture.vaultDir, "学习", "根笔记.md"), "utf8"),
      ).toContain(`id: ${noteId}`);
      // 树中文档仍只有一项（分组子级下）。
      await expect(
        window.getByRole("treeitem", { name: /根笔记/ }),
      ).toHaveCount(1, { timeout: UI_TIMEOUT });
      // 移动后可正常打开（来源缓存路径已同步，不回写旧路径）。
      await window.getByRole("treeitem", { name: /根笔记/ }).click();
      await expect(
        window.locator(".editor__content .ProseMirror"),
      ).toContainText("根目录正文。");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });
});
