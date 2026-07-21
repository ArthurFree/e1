import { expect, test, type Page } from "@playwright/test";

/** 应用已加载（标题输入框出现即就绪）。 */
async function waitAppReady(page: Page) {
  await page.goto("/");
  await expect(page.getByLabel("文档标题")).toBeVisible();
}

test.describe("功能端到端", () => {
  test("欢迎文档加载，编辑经防抖自动保存，刷新后恢复", async ({ page }) => {
    await waitAppReady(page);
    await expect(page.getByLabel("文档标题")).toHaveValue("欢迎使用 Notion-like Web");

    const editor = page.locator(".editor__content");
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.type("端到端持久化验证");
    // 800ms 防抖 + 落盘余量
    await page.waitForTimeout(1500);

    await page.reload();
    await expect(page.getByLabel("文档标题")).toHaveValue("欢迎使用 Notion-like Web");
    await expect(page.locator(".editor__content")).toContainText("端到端持久化验证");
  });

  test("新建文档并出现在页面树，刷新后保留", async ({ page }) => {
    await waitAppReady(page);
    await page.getByRole("button", { name: "新建文档", exact: true }).click();
    // 等标题输入框同步到新文档（初始标题「无标题」）再填写，避免与本地状态同步竞态
    await expect(page.getByLabel("文档标题")).toHaveValue("无标题");
    await page.getByLabel("文档标题").fill("端到端新文档");
    await expect(page.getByLabel("文档标题")).toHaveValue("端到端新文档");
    await expect(page.getByRole("tree", { name: "页面树" })).toContainText("端到端新文档");

    await page.waitForTimeout(1000);
    await page.reload();
    await expect(page.getByRole("tree", { name: "页面树" })).toContainText("端到端新文档");
  });

  test("/ 命令菜单打开、过滤并用 Escape 关闭", async ({ page }) => {
    await waitAppReady(page);
    await page.locator(".editor__content").click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");

    // 种子文档表格里也含「AI 助手」字样，菜单项用 option 角色精确定位
    const headingOption = page.getByRole("option", { name: /标题 1/ });
    const aiOption = page.getByRole("option", { name: /AI 助手/ });
    await expect(headingOption).toBeVisible();
    await expect(aiOption).toBeVisible();

    await page.keyboard.type("biaoti");
    await expect(headingOption).toBeVisible();
    await expect(aiOption).toBeHidden();

    await page.keyboard.press("Escape");
    await expect(headingOption).toBeHidden();
  });

  test("未配置 AI 时安全降级，提示去设置", async ({ page }) => {
    await waitAppReady(page);
    await page.locator(".editor__content").click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/ai");
    await page.getByRole("option", { name: /AI 助手/ }).click();

    const dialog = page.getByRole("dialog", { name: "AI 助手" });
    await expect(dialog.getByText(/尚未配置 AI 服务/)).toBeVisible();
    await expect(dialog.getByText("打开设置")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("配置 AI 后请求目标 endpoint，结果确认后才写入文档", async ({ page }) => {
    let requested = false;
    await page.route("**/chat/completions", async (route) => {
      requested = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          choices: [{ message: { content: "润色结果文本" } }],
        }),
      });
    });

    await waitAppReady(page);

    // 配置 AI 服务
    await page.getByLabel("设置").click();
    const settings = page.getByRole("dialog", { name: "设置" });
    await settings.getByLabel("Endpoint").fill("https://ai.local/v1");
    await settings.getByLabel("模型").fill("test-model");
    await settings.getByLabel("API Key").fill("sk-e2e");
    await settings.getByRole("button", { name: "保存" }).click();
    await expect(settings.getByText("已保存。")).toBeVisible();
    await page.keyboard.press("Escape");

    // 全选正文 → 浮动工具栏 → 润色
    await page.locator(".editor__content").click();
    await page.keyboard.press("Meta+A");
    await page.getByRole("toolbar", { name: "文本格式" }).getByLabel("AI").click();
    await page.getByRole("menuitem", { name: "润色选区" }).click();

    // 结果先预览，未确认前文档不变
    const dialog = page.getByRole("dialog", { name: "润色选区" });
    await expect(dialog.getByLabel("AI 生成结果预览")).toContainText("润色结果文本");
    expect(requested).toBe(true);
    await expect(page.locator(".editor__content")).not.toContainText("润色结果文本");

    await dialog.getByRole("button", { name: "应用" }).click();
    await expect(page.locator(".editor__content")).toContainText("润色结果文本");
  });

  test("删除进回收站并可恢复", async ({ page }) => {
    await waitAppReady(page);
    await page.getByRole("button", { name: "新建文档", exact: true }).click();
    await expect(page.getByLabel("文档标题")).toHaveValue("无标题");
    await page.getByLabel("文档标题").fill("待删除文档");
    await expect(page.getByLabel("文档标题")).toHaveValue("待删除文档");
    const tree = page.getByRole("tree", { name: "页面树" });
    await expect(tree).toContainText("待删除文档");

    await tree.getByText("待删除文档").hover();
    await page.getByLabel("删除「待删除文档」").click();
    await expect(tree).not.toContainText("待删除文档");

    await page.getByLabel("回收站").click();
    const trash = page.getByRole("dialog", { name: "回收站" });
    await expect(trash).toContainText("待删除文档");
    // 行内操作按钮悬停才显示
    await trash.getByText("待删除文档").hover();
    await trash.getByLabel("恢复「待删除文档」").click();
    await expect(trash).toContainText("回收站是空的");
    await page.keyboard.press("Escape");
    await expect(tree).toContainText("待删除文档");
  });
});
