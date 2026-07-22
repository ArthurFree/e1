import { expect, test, type Page } from "@playwright/test";

/**
 * 响应式冒烟：1024 / 768 / 375 宽度下开始首页、文档树与浮层可用且不溢出。
 * 基准视觉为 1440 × 900，窄屏只验证可用性（见 docs/test-plan.md）。
 */

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

const VIEWPORTS = [
  { width: 1024, height: 800 },
  { width: 768, height: 900 },
  { width: 375, height: 700 },
];

for (const viewport of VIEWPORTS) {
  test.describe(`响应式 ${viewport.width}px`, () => {
    test.use({ viewport });

    test("开始首页可用且无横向溢出", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "开始" })).toBeVisible();
      await expect(page.getByLabel("快速操作")).toBeVisible();
      await expect(page.getByLabel("文档活动")).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });

    test("文档树与搜索浮层不溢出", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "开始" })).toBeVisible();

      // 窄屏下文档树为抽屉，由 ☰ 打开
      const toggle = page.getByLabel("打开文档树");
      if (await toggle.isVisible()) {
        await toggle.click();
        await expect(page.getByRole("tree", { name: "页面树" })).toBeVisible();
        await expectNoHorizontalOverflow(page);
        // 抽屉通过点击遮罩关闭（点在抽屉之外的右缘）
        await page
          .locator(".backdrop")
          .click({ position: { x: viewport.width - 10, y: Math.floor(viewport.height / 2) } });
      }

      // ≤767px 工作区轨道按设计隐藏，无搜索/回收站入口；只在入口存在时检查浮层
      const searchButton = page.getByLabel("搜索");
      if (!(await searchButton.isVisible())) {
        return;
      }
      await searchButton.click();
      const dialog = page.getByRole("dialog", { name: "全局搜索" });
      await expect(dialog).toBeVisible();
      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      await expectNoHorizontalOverflow(page);
    });
  });
}
