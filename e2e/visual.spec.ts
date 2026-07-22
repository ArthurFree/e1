import { expect, test, type Page } from "@playwright/test";

/**
 * 视觉回归：1440 × 900 固定视口中文截图基线。
 * 动态内容（回收站日期、保存时间、字数）做 mask；光标与动画由全局配置屏蔽。
 * 基线更新：npm run test:e2e:update
 */

async function gotoStart(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "开始" })).toBeVisible();
}

/** 打开欢迎文档并回滚正文到顶部（autofocus 会把长文档滚到底部）。 */
async function openWelcome(page: Page) {
  await gotoStart(page);
  await page
    .getByRole("tree", { name: "页面树" })
    .getByText("欢迎使用 Notion-like Web")
    .first()
    .click();
  await expect(page.getByLabel("文档标题")).toHaveValue("欢迎使用 Notion-like Web");
  await page.locator(".doc-scroll").evaluate((el) => el.scrollTo(0, 0));
}

test.describe("视觉回归（1440 × 900）", () => {
  test("开始首页", async ({ page }) => {
    await gotoStart(page);
    await expect(page).toHaveScreenshot("start-page.png");
  });

  test("知识库首页", async ({ page }) => {
    await gotoStart(page);
    await page.getByLabel("切换知识库").click();
    await page
      .getByRole("menu", { name: "知识库列表" })
      .getByRole("menuitem", { name: "我的知识库" })
      .click();
    await expect(page.getByRole("heading", { name: "我的知识库" })).toBeVisible();
    await expect(page).toHaveScreenshot("workspace-home.png", {
      mask: [page.locator(".ws-home time, .ws-home [data-dynamic]")],
    });
  });

  test("文档编辑区（浅色，含常驻工具栏）", async ({ page }) => {
    await openWelcome(page);
    await expect(page).toHaveScreenshot("document-light.png");
  });

  test("文档编辑区（深色）", async ({ page }) => {
    await openWelcome(page);
    await page.getByLabel("切换到深色主题").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page).toHaveScreenshot("document-dark.png");
  });

  test("最近视图", async ({ page }) => {
    await openWelcome(page);
    await page.getByRole("button", { name: "最近", exact: true }).click();
    await expect(page.getByRole("tab", { name: "浏览过" })).toBeVisible();
    await expect(page).toHaveScreenshot("recent-view.png", {
      mask: [page.locator("time")],
    });
  });

  test("收藏视图", async ({ page }) => {
    await openWelcome(page);
    await page.getByLabel("收藏文档").click();
    await page.getByRole("button", { name: "收藏", exact: true }).click();
    await expect(page.locator("main")).toContainText("欢迎使用 Notion-like Web");
    await expect(page).toHaveScreenshot("favorites-view.png", {
      mask: [page.locator("time")],
    });
  });

  test("模板中心", async ({ page }) => {
    await gotoStart(page);
    await page.getByLabel("快速操作").getByText("模板中心").click();
    await expect(page.getByRole("dialog", { name: "模板中心" })).toBeVisible();
    await expect(page).toHaveScreenshot("template-center.png");
  });

  test("/ 命令菜单", async ({ page }) => {
    await openWelcome(page);
    await page.locator(".editor__content").click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    await expect(page.getByRole("option", { name: /标题 1/ })).toBeVisible();
    await expect(page).toHaveScreenshot("slash-menu.png");
  });

  test("浮动工具栏", async ({ page }) => {
    await openWelcome(page);
    // 双击选中固定位置的词，避免选区跨块导致的不确定滚动
    await page.locator(".editor__content p").first().dblclick();
    await expect(page.getByRole("toolbar", { name: "文本格式" })).toBeVisible();
    await expect(page).toHaveScreenshot("bubble-toolbar.png");
  });

  test("版本历史", async ({ page }) => {
    await openWelcome(page);
    // 编辑触发一次保存以生成自动版本
    await page.locator(".editor__content").click();
    await page.keyboard.press("End");
    await page.keyboard.type("版本基线");
    await expect(page.getByRole("status")).toContainText("已保存", { timeout: 5000 });
    await page.getByLabel("版本历史").click();
    const panel = page.getByRole("dialog", { name: "版本历史" });
    await expect(panel.getByText("自动").first()).toBeVisible();
    await expect(page).toHaveScreenshot("version-panel.png", {
      mask: [page.locator(".version-panel__time"), page.getByRole("status")],
    });
  });

  test("搜索面板", async ({ page }) => {
    await gotoStart(page);
    await page.getByLabel("搜索").click();
    await page.getByLabel("搜索文档").fill("欢迎");
    await expect(page.getByRole("dialog", { name: "全局搜索" })).toContainText(
      "欢迎使用 Notion-like Web",
    );
    await expect(page).toHaveScreenshot("search-panel.png");
  });

  test("回收站", async ({ page }) => {
    await gotoStart(page);
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
    await gotoStart(page);
    await page.getByLabel("设置").click();
    await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();
    await expect(page).toHaveScreenshot("settings-panel.png");
  });
});
