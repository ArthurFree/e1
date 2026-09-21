/**
 * Desktop E2E 就绪等待：等页面树出现、再打开文档并等到标题与正文 hydrate。
 * 不能用加长 timeout 掩盖「树/文档尚未 ready」。
 */
import { expect, type Page } from "@playwright/test";
import { clickTreeItem } from "./tree";

const READY_TIMEOUT = 15_000;

/** 等应用壳与当前 Vault 页面树可见。 */
export async function waitDesktopWorkspaceReady(window: Page): Promise<void> {
  await window.waitForLoadState("domcontentloaded");
  await expect(window.getByRole("tree").first()).toBeVisible({
    timeout: READY_TIMEOUT,
  });
}

/**
 * 点击页面树标题打开文档，等到标题栏与正文就绪。
 * 树点击走 clickTreeItem（避开行内动作按钮）。
 */
export async function waitDocumentReady(
  window: Page,
  options: { pageName: string; expectedText?: string },
): Promise<void> {
  await waitDesktopWorkspaceReady(window);
  await clickTreeItem(window, options.pageName);
  await expect(window.getByRole("textbox", { name: "文档标题" })).toHaveValue(
    options.pageName,
    { timeout: READY_TIMEOUT },
  );
  const editor = window.locator(".editor__content .ProseMirror");
  await expect(editor).toBeVisible({ timeout: READY_TIMEOUT });
  if (options.expectedText) {
    await expect(editor).toContainText(options.expectedText, {
      timeout: READY_TIMEOUT,
    });
  }
}
