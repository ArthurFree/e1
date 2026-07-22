import { expect, test, type Page } from "@playwright/test";

/**
 * R002 阶段 3：开始首页与知识库首页的四档宽度视觉基线。
 * 动态时间列做 mask。
 */

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 768, height: 900 },
  { width: 390, height: 844 },
];

async function gotoStart(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "开始" })).toBeVisible();
}

/** 打开知识库首页：宽屏走全局侧栏，窄屏走树抽屉的「首页」入口。 */
async function gotoWorkspaceHome(page: Page, width: number) {
  await gotoStart(page);
  if (width >= 1024) {
    await page.getByLabel("知识库「我的知识库」").click();
  } else {
    await page.getByLabel("打开文档树").click();
    await page.getByRole("button", { name: "首页" }).click();
  }
  await expect(page.getByRole("heading", { name: "我的知识库" })).toBeVisible();
}

for (const viewport of VIEWPORTS) {
  test.describe(`页面基线 ${viewport.width}px`, () => {
    test.use({ viewport });

    test("开始首页", async ({ page }) => {
      await gotoStart(page);
      await expect(page).toHaveScreenshot(`dashboard-${viewport.width}.png`, {
        mask: [page.locator(".activity-table__time")],
      });
    });

    test("知识库首页", async ({ page }) => {
      await gotoWorkspaceHome(page, viewport.width);
      await expect(page).toHaveScreenshot(`knowledge-home-${viewport.width}.png`, {
        mask: [page.locator(".ws-home__doc-time")],
      });
    });
  });
}

test("开始首页（深色）", async ({ page }) => {
  // 主题开关在文档顶栏：先打开文档切换深色，再返回开始首页
  await gotoStart(page);
  await page
    .getByRole("tree", { name: "页面树" })
    .getByText("欢迎使用 Notion-like Web")
    .first()
    .click();
  await page.getByLabel("切换到深色主题").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByLabel("开始").click();
  await expect(page.getByRole("heading", { name: "开始" })).toBeVisible();
  await expect(page).toHaveScreenshot("dashboard-dark-1440.png", {
    mask: [page.locator(".activity-table__time")],
  });
});
