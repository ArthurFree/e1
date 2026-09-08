// R011.1 收口：页面树交互共享 helper。
// R011 把 document.renameFile 等操作开关翻 true 后，行内动作按钮在 hover 时
// 浮现并覆盖行几何中心，getByRole("treeitem").click() 的点中心会误触
// 「新建子文档」等动作（R007 阶段 5 偏差 3 已记录同型问题）；改点标题文本
// （.tree-row__title 无 stopPropagation，点击冒泡到行 onClick 选中页面，
// 与 desktop.links.spec.ts 的 openDocumentAndWaitReady 同口径）。
import { expect, type Page } from "@playwright/test";

/** RegExp 转义（treeitem 名按子串匹配，页名原样嵌入前需转义）。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 定位页面树条目（string 按转义后的子串匹配，RegExp 原样使用）。 */
export function treeItem(window: Page, name: string | RegExp) {
  return window.getByRole("treeitem", {
    name: typeof name === "string" ? new RegExp(escapeRegExp(name)) : name,
  });
}

/**
 * 点击页面树条目选中页面：点标题文本而非行几何中心，
 * 避开 hover 浮现的行内动作按钮。
 */
export async function clickTreeItem(
  window: Page,
  name: string | RegExp,
): Promise<void> {
  const item = treeItem(window, name);
  await expect(item).toBeVisible({ timeout: 10_000 });
  await item.locator(".tree-row__title").click();
}
