// R010 Stage 7（§16）：内部链接 / 反向链接 / 失效链接 Desktop E2E
//（Playwright _electron，生产模式）。describe 以「桌面冒烟」为前缀：
// 默认 test:e2e 经 --grep-invert 排除，独立运行用 npm run test:e2e:desktop。
//
// @golden G21 @ 插入内部链接 / G25 来源页 outgoing 面板；
// @golden G23 点击内部链接打开目标 / G24 目标页 backlink；
// @golden G22 保存 → 重启 → 链接仍可点击 / G30 中文路径；
// @golden G26 外部编辑加链接 → watcher → backlink 出现；
// @golden G27 删除目标 → broken / G28 恢复目标 → broken 自动恢复；
// @golden G29 broken 重新定位（失效链接面板 → PagePicker → 落盘改写）。
//
// 索引断言优先走 IPC（window.e1.links.*）锁定事实，再断言 UI 面板；
// watcher 链路延迟口径同 desktop.watcher.spec.ts（一律 poll / 长超时）。
import { test, expect, _electron as electron } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requireDesktopArtifacts } from "./desktopArtifacts";

const VAULT_ID = "v-e2e-links";

interface LinksFixture {
  vaultDir: string;
  userDataDir: string;
  vaultName: string;
  cleanup(): Promise<void>;
}

async function createFixture(
  files: Array<[string, string]>,
): Promise<LinksFixture> {
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "e1-vault-links-"));
  const vaultName = path.basename(vaultDir);
  for (const [rel, content] of files) {
    const abs = path.join(vaultDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
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
  const userDataDir = await mkdtemp(
    path.join(os.tmpdir(), "e1-userdata-links-"),
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
    vaultName,
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

/** 链接索引 IPC 调用的弱类型桥（与 desktop.search.spec.ts 同口径）。 */
interface LinksBridge {
  status(input: { vaultId: string }): Promise<{ state: string }>;
  broken(input: { vaultId: string }): Promise<unknown[]>;
  backlinks(input: { vaultId: string; noteKey: string }): Promise<unknown[]>;
  outgoing(input: { vaultId: string; noteKey: string }): Promise<unknown[]>;
}

function linksOf(window: Page) {
  return {
    status: () =>
      window.evaluate(async (vaultId) => {
        const e1 = (window as unknown as { e1?: { links?: LinksBridge } }).e1;
        return (await e1?.links?.status({ vaultId }))?.state ?? null;
      }, VAULT_ID),
    brokenCount: () =>
      window.evaluate(async (vaultId) => {
        const e1 = (window as unknown as { e1?: { links?: LinksBridge } }).e1;
        return (await e1?.links?.broken({ vaultId }))?.length ?? -1;
      }, VAULT_ID),
    backlinkCount: (noteKey: string) =>
      window.evaluate(
        async ({ vaultId, key }) => {
          const e1 = (window as unknown as { e1?: { links?: LinksBridge } }).e1;
          return (
            (await e1?.links?.backlinks({ vaultId, noteKey: key }))?.length ??
            -1
          );
        },
        { vaultId: VAULT_ID, key: noteKey },
      ),
    outgoingCount: (noteKey: string) =>
      window.evaluate(
        async ({ vaultId, key }) => {
          const e1 = (window as unknown as { e1?: { links?: LinksBridge } }).e1;
          return (
            (await e1?.links?.outgoing({ vaultId, noteKey: key }))?.length ?? -1
          );
        },
        { vaultId: VAULT_ID, key: noteKey },
      ),
  };
}

/** 等链接索引 ready（打开 Vault 自动 prepare → rebuild）。 */
async function waitLinkIndexReady(window: Page) {
  await expect
    .poll(async () => linksOf(window).status(), { timeout: 15_000 })
    .toBe("ready");
}

/** 树渲染 + 文档打开后稍等 watcher 就绪（chokidar 初始扫描事件会被吞）。 */
const WATCHER_READY_MS = 800;
/** watcher → reconciler → 索引/UI 全链路断言超时。 */
const LINK_TIMEOUT = 15_000;

/** 在当前打开的文档中经 @ 建议弹层插入指向 targetTitle 的内部链接。 */
async function insertInternalLink(window: Page, targetTitle: string) {
  const editor = window.locator(".editor__content .ProseMirror");
  await editor.click();
  // suggestion 触发字符前必须是空白/行首（Tiptap allowedPrefixes 缺省），
  // 先补一个空格再输入 @。
  await window.keyboard.type(" @");
  const option = window.getByRole("option", { name: targetTitle });
  await expect(option).toBeVisible({ timeout: 5000 });
  await option.click();
  await expect(
    editor.locator("span.internal-link", { hasText: targetTitle }),
  ).toBeVisible();
}

test.describe("桌面冒烟：内部链接与失效链接（R010 Stage 7 §16）", () => {
  test.beforeAll(() => {
    requireDesktopArtifacts();
  });

  test("@golden G21/G25/G23/G24：@ 插入 → 来源 outgoing → 点击打开目标 → 目标 backlink", async () => {
    const sourceId = "01JE2ELINK000000000001";
    const fixture = await createFixture([
      ["索引.md", note(sourceId, "索引页", "索引正文。")],
      [
        "学习/React.md",
        note("01JE2ELINK000000000002", "React 笔记", "组件化与 Hooks 要点。"),
      ],
    ]);
    const sourceAbs = path.join(fixture.vaultDir, "索引.md");
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitLinkIndexReady(window);
      await window.getByRole("treeitem", { name: /索引页/ }).click();
      const editor = window.locator(".editor__content .ProseMirror");
      await expect(editor).toContainText("索引正文。");

      // G21：@ 插入内部链接（internalLink 节点出现在编辑器中）。
      await insertInternalLink(window, "React 笔记");
      // 自动保存落盘为相对 Markdown 链接（portable 序列化）。
      await expect
        .poll(async () => readFile(sourceAbs, "utf8"), { timeout: 10_000 })
        .toContain("[React 笔记](学习/React.md)");
      // 索引经自写钩子 upsert（IPC 事实断言）。
      await expect
        .poll(async () => linksOf(window).outgoingCount(sourceId), {
          timeout: LINK_TIMEOUT,
        })
        .toBe(1);

      // G25：来源页「此页面引用」面板显示出站链接。
      await expect(window.getByText("此页面引用 · 1")).toBeVisible({
        timeout: LINK_TIMEOUT,
      });
      await expect(
        window.locator(".doc-links__item", { hasText: "React 笔记" }),
      ).toBeVisible();

      // G23：点击编辑器内的内部链接 → 打开目标文档。
      await editor
        .locator("span.internal-link", { hasText: "React 笔记" })
        .click();
      await expect(editor).toContainText("组件化与 Hooks 要点。", {
        timeout: 10_000,
      });

      // G24：目标页「引用此页面」面板显示来源文档。
      await expect(window.getByText("引用此页面 · 1")).toBeVisible({
        timeout: LINK_TIMEOUT,
      });
      await expect(
        window.locator(".doc-links__backlink", { hasText: "索引页" }),
      ).toBeVisible();
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G22/G30：中文嵌套路径——保存 → 重启 → 链接仍可点击打开目标", async () => {
    const fixture = await createFixture([
      [
        "学习/深入/源文档.md",
        note("01JE2ELINK000000000011", "中文源", "源正文。"),
      ],
      [
        "学习/参考/目标文档.md",
        note("01JE2ELINK000000000012", "中文目标", "目标正文内容。"),
      ],
    ]);
    const sourceAbs = path.join(fixture.vaultDir, "学习", "深入", "源文档.md");

    const app1 = await launch(fixture.userDataDir);
    try {
      const window = await app1.firstWindow();
      await waitLinkIndexReady(window);
      await window.getByRole("treeitem", { name: /中文源/ }).click();
      const editor = window.locator(".editor__content .ProseMirror");
      await expect(editor).toContainText("源正文。");
      await insertInternalLink(window, "中文目标");
      // 跨目录的相对链接（含中文路径段）落盘。
      await expect
        .poll(async () => readFile(sourceAbs, "utf8"), { timeout: 10_000 })
        .toContain("[中文目标](../参考/目标文档.md)");
    } finally {
      await app1.close();
    }

    // G22：重启后链接仍在且可点击（Markdown 链接 → internalLink 节点回解）。
    const app2 = await launch(fixture.userDataDir);
    try {
      const window = await app2.firstWindow();
      await waitLinkIndexReady(window);
      await window
        .getByRole("treeitem", { name: /中文源/ })
        .click({ timeout: LINK_TIMEOUT });
      const editor = window.locator(".editor__content .ProseMirror");
      await expect(editor).toContainText("源正文。");
      const link = editor.locator("span.internal-link", {
        hasText: "中文目标",
      });
      await expect(link).toBeVisible();
      await link.click();
      await expect(editor).toContainText("目标正文内容。", {
        timeout: 10_000,
      });
    } finally {
      await app2.close();
      await fixture.cleanup();
    }
  });

  test("@golden G26：外部编辑 Markdown 添加链接 → watcher → 目标页 backlink 出现", async () => {
    const targetId = "01JE2ELINK000000000021";
    const fixture = await createFixture([
      ["目标.md", note(targetId, "目标页", "目标正文。")],
      ["外部源.md", note("01JE2ELINK000000000022", "外部源", "尚无链接。")],
    ]);
    const sourceAbs = path.join(fixture.vaultDir, "外部源.md");
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitLinkIndexReady(window);
      await window.getByRole("treeitem", { name: /目标页/ }).click();
      await expect(
        window.locator(".editor__content .ProseMirror"),
      ).toContainText("目标正文。");
      await window.waitForTimeout(WATCHER_READY_MS);

      // 外部程序在另一篇文档中加入指向目标页的链接。
      await appendFile(sourceAbs, "\n参考 [目标页](目标.md)。\n", "utf8");

      // watcher → reconciler → links.upsert（IPC 事实断言）。
      await expect
        .poll(async () => linksOf(window).backlinkCount(targetId), {
          timeout: LINK_TIMEOUT,
        })
        .toBe(1);
      // 当前打开的目标页面板随外部变更刷新，出现 backlink。
      await expect(window.getByText("引用此页面 · 1")).toBeVisible({
        timeout: LINK_TIMEOUT,
      });
      await expect(
        window.locator(".doc-links__backlink", { hasText: "外部源" }),
      ).toBeVisible();
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G27/G28：删除目标 → broken → 恢复目标自动复原", async () => {
    const targetId = "01JE2ELINK000000000032";
    const fixture = await createFixture([
      [
        "源.md",
        note("01JE2ELINK000000000031", "源页", "指向 [目标页](目标.md)。"),
      ],
      ["目标.md", note(targetId, "目标页", "目标正文。")],
    ]);
    const targetAbs = path.join(fixture.vaultDir, "目标.md");
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitLinkIndexReady(window);
      expect(await linksOf(window).brokenCount()).toBe(0);
      await window.getByRole("treeitem", { name: /源页/ }).click();
      await expect(
        window.locator(".editor__content .ProseMirror"),
      ).toContainText("指向");
      await expect(window.getByText("此页面引用 · 1")).toBeVisible({
        timeout: LINK_TIMEOUT,
      });
      await window.waitForTimeout(WATCHER_READY_MS);

      // G27：外部删除目标 → 链接翻 broken，来源面板显示「目标不存在」。
      await rm(targetAbs);
      await expect
        .poll(async () => linksOf(window).brokenCount(), {
          timeout: LINK_TIMEOUT,
        })
        .toBe(1);
      await expect(window.getByText("目标不存在")).toBeVisible({
        timeout: LINK_TIMEOUT,
      });

      // G28：外部以同一 stable id 恢复目标 → broken 自动复原（重解析副产品）。
      await writeFile(
        targetAbs,
        note(targetId, "目标页", "目标正文。"),
        "utf8",
      );
      await expect
        .poll(async () => linksOf(window).brokenCount(), {
          timeout: LINK_TIMEOUT,
        })
        .toBe(0);
      await expect(window.getByText("目标不存在")).toHaveCount(0, {
        timeout: LINK_TIMEOUT,
      });
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G29：失效链接重新定位（面板 → PagePicker → 落盘改写）", async () => {
    const fixture = await createFixture([
      [
        "断链源.md",
        note(
          "01JE2ELINK000000000041",
          "断链源",
          "参考 [旧方案](归档/旧方案.md)。",
        ),
      ],
      ["新目标.md", note("01JE2ELINK000000000042", "新目标页", "新目标正文。")],
    ]);
    const sourceAbs = path.join(fixture.vaultDir, "断链源.md");
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitLinkIndexReady(window);
      await expect
        .poll(async () => linksOf(window).brokenCount(), {
          timeout: LINK_TIMEOUT,
        })
        .toBe(1);

      // 知识库首页 →「失效链接」面板。
      await window.getByLabel(/知识库「/).click();
      await window.getByRole("button", { name: "失效链接" }).click();
      const panel = window.getByRole("dialog", { name: "失效链接" });
      await expect(panel.getByText("断链源")).toBeVisible();
      await expect(panel.getByText("归档/旧方案.md")).toBeVisible();
      await expect(panel.getByText("目标不存在")).toBeVisible();

      // 重新定位：PagePicker 选择新目标页面。
      await panel.getByRole("button", { name: "重新定位" }).click();
      const picker = window.getByRole("dialog", { name: "选择页面" });
      await picker.getByRole("option", { name: /新目标页/ }).click();

      // 命中行移除 → 列表清空；磁盘 href 被改写为新目标相对路径。
      await expect(panel.getByText("没有失效链接。")).toBeVisible({
        timeout: LINK_TIMEOUT,
      });
      await expect
        .poll(async () => readFile(sourceAbs, "utf8"), { timeout: 10_000 })
        .toContain("[旧方案](新目标.md)");
      await expect
        .poll(async () => linksOf(window).brokenCount(), {
          timeout: LINK_TIMEOUT,
        })
        .toBe(0);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });
});
