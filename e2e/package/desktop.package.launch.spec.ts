// R009 Stage 3：Packaged App E2E —— P01 启动 / P02 打开 Vault。
// describe 以「安装包冒烟」为前缀：Web 套件（test:e2e）经 --grep-invert 排除，
// repo 模式桌面套件（test:e2e:desktop，--grep "桌面冒烟"）不命中，
// 独立运行用 npm run test:e2e:package。
// 产物缺失时本地 test.skip、CI 报错（requirePackagedArtifact，同
// requireDesktopArtifacts 口径）。
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requirePackagedArtifact } from "../desktopArtifacts";
import {
  createPackageVaultFixture,
  launchPackaged,
  note,
} from "./packageFixture";

test.describe("安装包冒烟：启动与打开 Vault（P01/P02）", () => {
  test.beforeAll(() => {
    requirePackagedArtifact();
  });

  test("P01：安装包启动 → 窗口出现、无错误页、IPC 桥存在", async () => {
    // 空 userData（无最近 Vault）：应进入开始首页而非崩溃/错误页。
    const userDataDir = await mkdtemp(
      path.join(os.tmpdir(), "e1-userdata-pkg-"),
    );
    const app = await launchPackaged(userDataDir);
    try {
      const window = await app.firstWindow();
      await expect(window.getByRole("heading", { name: "开始" })).toBeVisible({
        timeout: 15_000,
      });
      // preload 桥真实装配（packaged 的 preload.cjs 从 asar 加载）。
      const platform = await window.evaluate(
        () =>
          (window as unknown as { e1?: { platform?: string } }).e1?.platform ??
          null,
      );
      expect(platform).toBe("desktop");
      // 无统一错误块（打开链路失败时的 .content-error）。
      await expect(window.locator(".content-error")).toHaveCount(0);
    } finally {
      await app.close();
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("P02：预置最近 Vault → 启动自动进入 → 页面树出现", async () => {
    const fixture = await createPackageVaultFixture(
      [
        ["根笔记.md", note("01JE2EPKG0000000000101", "根笔记", "根正文。")],
        [
          "学习/React 进阶.md",
          note("01JE2EPKG0000000000102", "React 进阶", "组件化。"),
        ],
      ],
      "v-e2e-pkg-launch",
    );
    const app = await launchPackaged(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await expect(
        window.getByRole("treeitem", { name: /根笔记/ }),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        window.getByRole("treeitem", { name: /React 进阶/ }),
      ).toBeVisible();
      // 文档可打开（Markdown 扫描 + 读取全链路在 packaged 下走通）。
      await window.getByRole("treeitem", { name: /根笔记/ }).click();
      await expect(
        window.locator(".editor__content .ProseMirror"),
      ).toContainText("根正文。", { timeout: 15_000 });
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });
});
