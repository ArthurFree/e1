// R010 Stage 7（§16）：Packaged App E2E —— P10 内部链接 / P11 backlinks /
// P12 watcher 更新链接索引。describe 以「安装包冒烟」为前缀，
// 独立运行用 npm run test:e2e:package。
// packaged 专属价值：隔离 userData 下链接索引从零 rebuild，直接验证 asar 内
// node:sqlite 链接表组与 chokidar → reconciler → links.upsert 全链路
//（repo 模式掩盖不了缺依赖）。
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { requirePackagedArtifact } from "../desktopArtifacts";
import {
  createPackageVaultFixture,
  launchPackaged,
  note,
} from "./packageFixture";

const VAULT_ID = "v-e2e-pkg-links";

interface LinksBridge {
  status(input: { vaultId: string }): Promise<{ state: string }>;
  backlinks(input: { vaultId: string; noteKey: string }): Promise<unknown[]>;
}

/** 等链接索引 ready（打开 Vault 自动 prepare → rebuild）。 */
async function waitLinkIndexReady(window: Page) {
  await expect
    .poll(
      async () =>
        window.evaluate(async (vaultId) => {
          const e1 = (window as unknown as { e1?: { links?: LinksBridge } }).e1;
          return (await e1?.links?.status({ vaultId }))?.state ?? null;
        }, VAULT_ID),
      { timeout: 15_000 },
    )
    .toBe("ready");
}

/** watcher → reconciler → 索引/UI 全链路断言超时。 */
const LINK_TIMEOUT = 15_000;
/** 树渲染 + 文档打开后稍等 watcher 就绪（chokidar 初始扫描事件会被吞）。 */
const WATCHER_READY_MS = 800;

test.describe("安装包冒烟：内部链接与反向链接（P10/P11/P12）", () => {
  test.beforeAll(() => {
    requirePackagedArtifact();
  });

  test("P10/P11：内部链接点击打开目标，目标页显示 backlink", async () => {
    const fixture = await createPackageVaultFixture(
      [
        [
          "源.md",
          note("01JE2EPKGLINK0000000001", "源页", "指向 [目标页](目标.md)。"),
        ],
        ["目标.md", note("01JE2EPKGLINK0000000002", "目标页", "目标正文。")],
      ],
      VAULT_ID,
    );
    const app = await launchPackaged(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      // 隔离 userData → 链接索引从零 rebuild（packaged 下 node:sqlite）。
      await waitLinkIndexReady(window);
      await window.getByRole("treeitem", { name: /源页/ }).click();
      const editor = window.locator(".editor__content .ProseMirror");
      await expect(editor).toContainText("指向", { timeout: 15_000 });

      // P10：Markdown 链接回解为 internalLink 节点，点击打开目标文档。
      const link = editor.locator("span.internal-link", { hasText: "目标页" });
      await expect(link).toBeVisible();
      await link.click();
      await expect(editor).toContainText("目标正文。", { timeout: 10_000 });

      // P11：目标页「引用此页面」面板显示来源文档。
      await expect(window.getByText("引用此页面 · 1")).toBeVisible({
        timeout: LINK_TIMEOUT,
      });
      await expect(
        window.locator(".doc-links__backlink", { hasText: "源页" }),
      ).toBeVisible();
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("P12：外部编辑 Markdown 添加链接 → watcher 更新链接索引 → backlink 出现", async () => {
    const targetId = "01JE2EPKGLINK0000000011";
    const fixture = await createPackageVaultFixture(
      [
        ["目标.md", note(targetId, "目标页", "目标正文。")],
        ["外部源.md", note("01JE2EPKGLINK0000000012", "外部源", "尚无链接。")],
      ],
      VAULT_ID,
    );
    const sourceAbs = path.join(fixture.vaultDir, "外部源.md");
    const app = await launchPackaged(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitLinkIndexReady(window);
      await window.getByRole("treeitem", { name: /目标页/ }).click();
      await expect(
        window.locator(".editor__content .ProseMirror"),
      ).toContainText("目标正文。", { timeout: 15_000 });
      await window.waitForTimeout(WATCHER_READY_MS);

      // 外部程序在另一篇文档中加入指向目标页的链接。
      await appendFile(sourceAbs, "\n参考 [目标页](目标.md)。\n", "utf8");

      // asar 内 chokidar → reconciler → links.upsert（IPC 事实断言）。
      await expect
        .poll(
          async () =>
            window.evaluate(
              async ({ vaultId, key }) => {
                const e1 = (
                  window as unknown as { e1?: { links?: LinksBridge } }
                ).e1;
                return (
                  (await e1?.links?.backlinks({ vaultId, noteKey: key }))
                    ?.length ?? -1
                );
              },
              { vaultId: VAULT_ID, key: targetId },
            ),
          { timeout: LINK_TIMEOUT },
        )
        .toBe(1);
      // 当前打开的目标页面板随外部变更刷新，出现 backlink。
      await expect(window.getByText("引用此页面 · 1")).toBeVisible({
        timeout: LINK_TIMEOUT,
      });
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });
});
