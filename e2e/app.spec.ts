import { expect, test, type Page } from "@playwright/test";

/** 应用已加载：默认进入全局「开始」首页。 */
async function gotoStart(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "开始" })).toBeVisible();
}

/** 从开始首页经页面树打开指定文档。 */
async function openDoc(page: Page, title: string) {
  await gotoStart(page);
  await page.getByRole("tree", { name: "页面树" }).getByText(title).first().click();
  await expect(page.getByLabel("文档标题")).toHaveValue(title);
}

test.describe("开始首页与知识库", () => {
  test("开始首页：快速操作卡片与文档活动区", async ({ page }) => {
    await gotoStart(page);
    const cards = page.getByLabel("快速操作");
    await expect(cards.getByText("新建文档")).toBeVisible();
    await expect(cards.getByText("新建知识库")).toBeVisible();
    await expect(cards.getByText("模板中心")).toBeVisible();
    await expect(cards.getByText("AI 帮你写")).toBeVisible();

    const activity = page.getByLabel("文档活动");
    await expect(activity.getByRole("tab", { name: "编辑过" })).toBeVisible();
    await expect(activity.getByRole("tab", { name: "浏览过" })).toBeVisible();
    await expect(activity).toContainText("欢迎使用 Notion-like Web");
  });

  test("从开始首页一键在最近知识库新建文档", async ({ page }) => {
    await gotoStart(page);
    // 启动时首个知识库被标记为最近使用，点击卡片主区域直接在其中创建
    await page.getByLabel("快速操作").getByText("新建文档").click();
    await expect(page.getByLabel("文档标题")).toHaveValue("无标题");
  });

  test("知识库首页：名称、收藏与目录概览", async ({ page }) => {
    await gotoStart(page);
    await page.getByLabel("知识库「我的知识库」").click();
    await expect(page.getByRole("heading", { name: "我的知识库" })).toBeVisible();
    await expect(page.getByLabel("收藏知识库")).toBeVisible();
    await expect(page.getByLabel("目录概览")).toContainText("欢迎使用 Notion-like Web");
  });

  test("收藏文档后出现在全局收藏视图", async ({ page }) => {
    await openDoc(page, "任务清单");
    await page.getByLabel("收藏文档").click();
    await expect(page.getByLabel("取消收藏文档")).toBeVisible();

    await page.getByRole("button", { name: "收藏", exact: true }).click();
    await expect(page.locator("main")).toContainText("任务清单");
  });

  test("最近视图跨知识库展示浏览记录", async ({ page }) => {
    await openDoc(page, "任务清单");
    await page.getByLabel("最近").click();
    await page.getByRole("tab", { name: "浏览过" }).click();
    await expect(page.locator("main")).toContainText("任务清单");
  });
});

test.describe("文档编辑", () => {
  test("编辑自动保存，刷新后内容与路由均恢复", async ({ page }) => {
    await openDoc(page, "欢迎使用 Notion-like Web");
    const editor = page.locator(".editor__content");
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.type("端到端持久化验证");
    // 保存状态出现「已保存」后再刷新
    await expect(page.getByRole("status")).toContainText("已保存", {
      timeout: 5000,
    });

    await page.reload();
    await expect(page.getByLabel("文档标题")).toHaveValue("欢迎使用 Notion-like Web");
    await expect(page.locator(".editor__content")).toContainText("端到端持久化验证");
  });

  test("保存状态、字数统计与版本历史", async ({ page }) => {
    await openDoc(page, "欢迎使用 Notion-like Web");
    await expect(page.getByLabel("字数统计详情")).toContainText("字词");

    const editor = page.locator(".editor__content");
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.type("版本历史验证");
    await expect(page.getByRole("status")).toContainText("未保存");
    await expect(page.getByRole("status")).toContainText("已保存", { timeout: 5000 });

    // 首次保存生成自动版本
    await page.getByLabel("版本历史").click();
    const panel = page.getByRole("dialog", { name: "版本历史" });
    await expect(panel.getByText("自动").first()).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("新建文档并出现在页面树，刷新后保留", async ({ page }) => {
    await gotoStart(page);
    await page.getByRole("button", { name: "新建文档", exact: true }).click();
    // 等标题输入框同步到新文档（初始标题「无标题」）再填写，避免与本地状态同步竞态
    await expect(page.getByLabel("文档标题")).toHaveValue("无标题");
    await page.getByLabel("文档标题").fill("端到端新文档");
    await expect(page.getByLabel("文档标题")).toHaveValue("端到端新文档");
    const tree = page.getByRole("tree", { name: "页面树" });
    await expect(tree).toContainText("端到端新文档");

    await page.reload();
    await expect(tree).toContainText("端到端新文档");
  });

  test("/ 命令菜单打开、过滤并用 Escape 关闭", async ({ page }) => {
    await openDoc(page, "欢迎使用 Notion-like Web");
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

  test("页面树支持方向键导航与 F2 重命名", async ({ page }) => {
    await gotoStart(page);
    const tree = page.getByRole("tree", { name: "页面树" });
    const items = tree.getByRole("treeitem");
    await items.first().focus();
    await page.keyboard.press("ArrowDown");
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(items.first()).toBeFocused();
    // F2 进入重命名，Escape 退出
    await page.keyboard.press("F2");
    await expect(tree.getByRole("textbox", { name: "重命名" })).toBeFocused();
    await page.keyboard.press("Escape");
  });

  test("常驻格式工具栏可直接设置标题", async ({ page }) => {
    // 会议纪要示例是普通段落文档（任务清单的列表项不能直接转为标题）
    await openDoc(page, "会议纪要示例");
    const editor = page.locator(".editor__content");
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("工具栏标题");

    const toolbar = page.locator(".format-toolbar");
    await expect(toolbar).toBeVisible();
    // 段落样式下拉选择 标题 1
    await toolbar.getByLabel("段落样式").click();
    await page.getByRole("menuitem", { name: "标题 1" }).click();
    await expect(editor.getByRole("heading", { name: "工具栏标题" })).toBeVisible();
  });
});

test.describe("模板与 AI", () => {
  test("模板中心创建普通文档", async ({ page }) => {
    await gotoStart(page);
    await page.getByLabel("快速操作").getByText("模板中心").click();
    const dialog = page.getByRole("dialog", { name: "模板中心" });
    await expect(dialog).toBeVisible();
    await dialog.getByText("会议纪要").first().click();
    // 选择创建位置
    const picker = page.getByRole("menu", { name: "选择创建位置" });
    await expect(picker).toBeVisible();
    await picker.getByRole("menuitem").first().click();
    await expect(page.getByLabel("文档标题")).toHaveValue(/会议/);
  });

  test("未配置 AI 时 /AI 助手安全降级", async ({ page }) => {
    await openDoc(page, "欢迎使用 Notion-like Web");
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

    await gotoStart(page);

    // 配置 AI 服务
    await page.getByLabel("设置").click();
    const settings = page.getByRole("dialog", { name: "设置" });
    await settings.getByLabel("Endpoint").fill("https://ai.local/v1");
    await settings.getByLabel("模型").fill("test-model");
    await settings.getByLabel("API Key").fill("sk-e2e");
    await settings.getByRole("button", { name: "保存" }).click();
    await expect(settings.getByText("已保存。")).toBeVisible();
    await page.keyboard.press("Escape");

    // 打开文档，全选正文 → 浮动工具栏 → 润色
    await page
      .getByRole("tree", { name: "页面树" })
      .getByText("欢迎使用 Notion-like Web")
      .first()
      .click();
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
});

test.describe("回收站", () => {
  test("删除进回收站并可恢复", async ({ page }) => {
    await gotoStart(page);
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
