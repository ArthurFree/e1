import { expect, test, type Page } from "@playwright/test";

/**
 * 视觉回归：1440 × 900 固定视口中文截图基线。
 * 动态内容（回收站日期）做 mask；光标与动画由全局配置屏蔽。
 * 基线更新：npm run test:e2e:update
 */

async function waitAppReady(page: Page) {
  await page.goto("/");
  await expect(page.getByLabel("文档标题")).toHaveValue("欢迎使用 Notion-like Web");
}

test.describe("视觉回归（1440 × 900）", () => {
  test("欢迎文档（浅色）", async ({ page }) => {
    await waitAppReady(page);
    await expect(page).toHaveScreenshot("welcome-light.png");
  });

  test("欢迎文档（深色）", async ({ page }) => {
    await waitAppReady(page);
    await page.getByLabel("切换到深色主题").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page).toHaveScreenshot("welcome-dark.png");
  });

  test("搜索面板", async ({ page }) => {
    await waitAppReady(page);
    await page.getByLabel("搜索").click();
    await page.getByLabel("搜索文档").fill("欢迎");
    await expect(page.getByRole("dialog", { name: "全局搜索" })).toContainText(
      "欢迎使用 Notion-like Web",
    );
    await expect(page).toHaveScreenshot("search-panel.png");
  });

  test("/ 命令菜单", async ({ page }) => {
    await waitAppReady(page);
    await page.locator(".editor__content").click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    await expect(page.getByRole("option", { name: /标题 1/ })).toBeVisible();
    await expect(page).toHaveScreenshot("slash-menu.png");
  });

  test("浮动工具栏", async ({ page }) => {
    await waitAppReady(page);
    // 文档加载时 autofocus 会把正文滚到底部，先回滚到顶部保证截图稳定
    await page.locator(".doc-scroll").evaluate((el) => el.scrollTo(0, 0));
    // 双击选中固定位置的词，避免选区跨块导致的不确定滚动
    await page.locator(".editor__content p").first().dblclick();
    await expect(page.getByRole("toolbar", { name: "文本格式" })).toBeVisible();
    await expect(page).toHaveScreenshot("bubble-toolbar.png");
  });

  test("回收站", async ({ page }) => {
    await waitAppReady(page);
    const tree = page.getByRole("tree", { name: "页面树" });
    await tree.getByText("会议纪要示例").hover();
    await page.getByLabel("删除「会议纪要示例」").click();

    await page.getByLabel("回收站").click();
    const trash = page.getByRole("dialog", { name: "回收站" });
    await expect(trash).toContainText("会议纪要示例");
    // 删除日期为动态内容，屏蔽
    await expect(page).toHaveScreenshot("trash-panel.png", {
      mask: [page.locator(".trash-panel__date")],
    });
  });

  test("设置面板", async ({ page }) => {
    await waitAppReady(page);
    await page.getByLabel("设置").click();
    await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();
    await expect(page).toHaveScreenshot("settings-panel.png");
  });
});
