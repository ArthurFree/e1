/**
 * 多标签页一致性端到端（R004 阶段 7 §7.2/§7.3 验收）：
 * 同一 browser context 开两个 page（共享 IndexedDB 存储与 BroadcastChannel），
 * 两个标签页编辑同一文档——后保存者收到乐观锁冲突提示，而不是静默覆盖。
 */
import { expect, test, type Page } from "@playwright/test";

/** 打开文档并等待编辑器就绪。 */
async function openDoc(page: Page, title: string) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "开始" })).toBeVisible();
  await page
    .getByRole("tree", { name: "页面树" })
    .getByText(title)
    .first()
    .click();
  await expect(page.getByLabel("文档标题")).toHaveValue(title);
}

test("两个标签页编辑同一文档：后保存者收到冲突提示，不发生静默覆盖", async ({
  context,
}) => {
  const page1 = await context.newPage();
  const page2 = await context.newPage();

  // 两个标签页打开同一文档（标签页 2 经持久化路由直接落入）。
  await openDoc(page1, "任务清单");
  await page2.goto("/");
  await expect(page2.getByLabel("文档标题")).toHaveValue("任务清单", {
    timeout: 10000,
  });

  // 标签页 2 持续输入保持 dirty（防抖不断重置，保存不落盘）；
  // 标签页 1 在此期间完成编辑并落盘，推进磁盘版本。
  await page2.locator(".editor__content").click();
  const localText = "乙标签页写入";
  for (let i = 0; i < localText.length; i += 1) {
    await page2.keyboard.type(localText[i]);
    if (i === 0) {
      await page1.locator(".editor__content").click();
      await page1.keyboard.press("End");
      await page1.keyboard.type("甲标签页写入");
    }
  }
  await expect(page1.getByRole("status")).toContainText("已保存", {
    timeout: 5000,
  });

  // 标签页 2 dirty 时收到远端落盘广播 → 冲突提示；
  // 停止输入后本地保存撞版本（DOCUMENT_CONFLICT）→ 冲突持续，不静默覆盖。
  await expect(page2.getByRole("alert").first()).toContainText("冲突", {
    timeout: 8000,
  });
  await expect(page2.getByRole("button", { name: "重新载入" })).toBeVisible();
  await expect(page2.getByRole("button", { name: "另存副本" })).toBeVisible();
  await expect(page2.getByRole("button", { name: "强制覆盖" })).toBeVisible();
  await expect(
    page2.getByRole("button", { name: "复制当前内容" }),
  ).toBeVisible();

  // 标签页 1 的内容仍是磁盘真相（未被覆盖）。
  await page1.reload();
  await expect(page1.getByLabel("文档标题")).toHaveValue("任务清单");
  await expect(page1.locator(".editor__content")).toContainText("甲标签页写入");
  await expect(page1.locator(".editor__content")).not.toContainText(
    "乙标签页写入",
  );

  // 冲突面板选项①：重新载入磁盘版本后，标签页 2 与磁盘一致。
  await page2.getByRole("button", { name: "重新载入" }).click();
  await expect(page2.locator(".editor__content")).toContainText(
    "甲标签页写入",
    { timeout: 5000 },
  );
  await expect(page2.locator(".editor__content")).not.toContainText(
    "乙标签页写入",
  );

  await page1.close();
  await page2.close();
});
