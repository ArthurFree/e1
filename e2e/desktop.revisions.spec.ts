// R012 Stage 7（需求 §40）：Desktop 版本历史 Golden E2E（G44–G56）。
// describe 以「桌面冒烟」为前缀；@golden 标记进黄金路径。
//
// 事实断言分两层：
// - 索引/版本/磁盘事实优先走 window.e1.revisions.* IPC 与 node fs（与
//   desktop.fileops.spec.ts 同口径）；
// - 面板行为（创建版本 / lazy preview / 二次确认恢复）走真实 UI
//   （EditorShell「版本历史」按钮 → VersionPanel dialog）。
//
// G49 说明：恢复冲突（DOCUMENT_CONFLICT）走 IPC 直验 Main 乐观锁——
// UI 路径下 watcher 对 clean 文档会自动重载并推进 SourceCache 令牌，
// 无法稳定制造「面板选中版本后令牌失配」的时序；UI 冲突文案由
// src/components/editor/RestoreRevisionRace.test.tsx 组件测试锁定。
import { test, expect, _electron as electron } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requireDesktopArtifacts } from "./desktopArtifacts";
import { clickTreeItem, treeItem } from "./tree";

const VAULT_ID = "v-e2e-revisions";
const UI_TIMEOUT = 15_000;

interface RevisionFixture {
  vaultDir: string;
  userDataDir: string;
  cleanup(): Promise<void>;
}

async function createFixture(
  files: Array<[string, string | Buffer]>,
): Promise<RevisionFixture> {
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "e1-vault-rev-"));
  const vaultName = path.basename(vaultDir);
  for (const [rel, content] of files) {
    const abs = path.join(vaultDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  await mkdir(path.join(vaultDir, ".e1"), { recursive: true });
  await writeFile(
    path.join(vaultDir, ".e1", "vault.json"),
    JSON.stringify({
      format: "e1-vault",
      formatVersion: 1,
      vaultId: VAULT_ID,
      name: vaultName,
      createdAt: "2026-08-10T00:00:00.000Z",
      assetsDirectory: "assets",
      identityMode: "frontmatter",
    }),
  );
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "e1-userdata-rev-"));
  await writeFile(
    path.join(userDataDir, "recent-vaults.json"),
    JSON.stringify([
      {
        vaultId: VAULT_ID,
        absolutePath: vaultDir,
        displayName: vaultName,
        lastOpenedAt: "2026-08-10T00:00:00.000Z",
      },
    ]),
  );
  return {
    vaultDir,
    userDataDir,
    async cleanup() {
      await rm(vaultDir, { recursive: true, force: true });
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}

function launch(userDataDir: string) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({
    args: ["."],
    env: { ...env, E1_USER_DATA_DIR: userDataDir },
  });
}

function note(id: string, title: string, body: string): string {
  return ["---", `id: ${id}`, `title: ${title}`, "---", "", body, ""].join(
    "\n",
  );
}

/** 带 tags 的笔记（G47 用：验证恢复不动 Frontmatter）。 */
function noteWithTags(id: string, title: string, tags: string, body: string) {
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    `tags: ${tags}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

/* ------------------------------ IPC 弱类型桥 ------------------------------ */

interface RevisionSummaryDto {
  revisionId: string;
  reason: "interval" | "manual" | "before-restore";
  createdAt: string;
  bodyBytes: number;
  textPreview: string;
}

interface RevisionBridge {
  list(input: {
    vaultId: string;
    relativePath: string;
    stableNoteId?: string | null;
  }): Promise<{ summaries: RevisionSummaryDto[]; degraded?: string[] }>;
  get(input: {
    vaultId: string;
    relativePath: string;
    stableNoteId?: string | null;
    revisionId: string;
  }): Promise<{
    revisionId: string;
    reason: string;
    body: string;
    bodyBytes: number;
    lineEnding: "lf" | "crlf";
    relativePathAtCapture: string;
  } | null>;
  capture(input: {
    vaultId: string;
    relativePath: string;
    stableNoteId?: string | null;
    reason: "interval" | "manual" | "before-restore";
    expectedVersionToken?: string;
  }): Promise<RevisionSummaryDto | null>;
  restore(input: {
    vaultId: string;
    relativePath: string;
    stableNoteId?: string | null;
    revisionId: string;
    expectedVersionToken: string;
  }): Promise<{ versionToken: string; updatedAt: number }>;
  prune(input: {
    vaultId: string;
    relativePath: string;
    stableNoteId?: string | null;
    keep?: number;
    maxBytes?: number;
  }): Promise<{ pruned: number }>;
  relocate(input: {
    vaultId: string;
    stableNoteId?: string | null;
    fromRelativePath: string;
    toRelativePath: string;
    prefix?: boolean;
  }): Promise<{ relocated: number }>;
}

interface NoteBridge {
  read(input: {
    vaultId: string;
    relativePath: string;
  }): Promise<{ versionToken: string; markdown: string }>;
}

interface FileOpBridge {
  plan(input: Record<string, unknown>): Promise<{
    blockers: Array<{ code: string; message: string }>;
    summary: { rewrittenLinks: number };
  }>;
  execute(input: {
    vaultId: string;
    plan: unknown;
  }): Promise<{ rewrittenLinks: number }>;
}

interface LinksBridge {
  status(input: { vaultId: string }): Promise<{ state: string }>;
  backlinks(input: {
    vaultId: string;
    noteKey: string;
  }): Promise<Array<{ sourcePageId: string; href: string }>>;
  outgoing(input: {
    vaultId: string;
    noteKey: string;
  }): Promise<Array<{ targetRelativePath: string | null; broken: boolean }>>;
}

interface SearchBridge {
  status(input: { vaultId: string }): Promise<{ state: string }>;
  query(input: {
    vaultId?: string;
    query: string;
  }): Promise<Array<{ relativePath: string; stableNoteId: string | null }>>;
}

type E1Bridge = {
  revisions?: RevisionBridge;
  note?: NoteBridge;
  fileOperation?: FileOpBridge;
  links?: LinksBridge;
  search?: SearchBridge;
};

// 注意：window.e1 上的方法不可跨 evaluate 序列化返回（函数会变成
// undefined），所有桥调用必须整体放进一次 evaluate 内执行。

/** revision.list IPC 直调（断言失败时返回 null，配合 expect.poll 重试）。 */
function listRevisions(
  window: Page,
  relativePath: string,
  stableNoteId: string | null,
) {
  return window.evaluate(
    async ({ vaultId, rel, sid }) => {
      const e1 = (window as unknown as { e1?: E1Bridge }).e1;
      if (!e1?.revisions) return null;
      return (
        await e1.revisions.list({
          vaultId,
          relativePath: rel,
          stableNoteId: sid,
        })
      ).summaries;
    },
    { vaultId: VAULT_ID, rel: relativePath, sid: stableNoteId },
  );
}

/** revision.capture IPC 直调（模拟节流到期 / 手工触发；Main 重读磁盘）。 */
function captureRevision(
  window: Page,
  input: {
    relativePath: string;
    stableNoteId: string | null;
    reason: "interval" | "manual" | "before-restore";
    expectedVersionToken?: string;
  },
) {
  return window.evaluate(
    async ({ vaultId, ...rest }) => {
      const e1 = (window as unknown as { e1?: E1Bridge }).e1;
      if (!e1?.revisions) throw new Error("revisions 未暴露");
      return e1.revisions.capture({ vaultId, ...rest });
    },
    { vaultId: VAULT_ID, ...input },
  );
}

/** 等应用就绪：preload 桥 + 页面树出现（Vault 已打开）。 */
async function waitAppReady(window: Page) {
  await window.waitForLoadState("domcontentloaded");
  await expect
    .poll(
      async () =>
        window.evaluate(() =>
          Boolean((window as unknown as { e1?: E1Bridge }).e1?.revisions),
        ),
      { timeout: UI_TIMEOUT },
    )
    .toBe(true);
  await expect(window.getByRole("tree").first()).toBeVisible({
    timeout: UI_TIMEOUT,
  });
}

/** 等链接索引 ready（fileOperation plan 与链接断言前置）。 */
async function waitLinksReady(window: Page) {
  await expect
    .poll(
      async () =>
        window.evaluate(async (vaultId) => {
          const e1 = (window as unknown as { e1?: E1Bridge }).e1;
          return (await e1?.links?.status({ vaultId }))?.state ?? null;
        }, VAULT_ID),
      { timeout: 20_000 },
    )
    .toBe("ready");
}

/** 等搜索索引 ready。 */
async function waitSearchReady(window: Page) {
  await expect
    .poll(
      async () =>
        window.evaluate(async (vaultId) => {
          const e1 = (window as unknown as { e1?: E1Bridge }).e1;
          return (await e1?.search?.status({ vaultId }))?.state ?? null;
        }, VAULT_ID),
      { timeout: 20_000 },
    )
    .toBe("ready");
}

/** 目标文档的反向链接数（IPC 事实断言；桥缺失返回 -1）。 */
function backlinkCount(window: Page, noteKey: string) {
  return window.evaluate(
    async ({ vaultId, key }) => {
      const e1 = (window as unknown as { e1?: E1Bridge }).e1;
      return (
        (await e1?.links?.backlinks({ vaultId, noteKey: key }))?.length ?? -1
      );
    },
    { vaultId: VAULT_ID, key: noteKey },
  );
}

/** 全文搜索 query 的命中行（IPC 事实断言；桥缺失返回 null）。 */
function searchHits(window: Page, query: string) {
  return window.evaluate(
    async ({ vaultId, query: q }) => {
      const e1 = (window as unknown as { e1?: E1Bridge }).e1;
      return (await e1?.search?.query({ vaultId, query: q })) ?? null;
    },
    { vaultId: VAULT_ID, query },
  );
}

/**
 * 打开文档并等待就绪（与 desktop.links.spec.ts openDocumentAndWaitReady
 * 同口径）：树点击走 clickTreeItem（行中心会被 hover 动作按钮遮挡）→
 * 标题 input 显示目标页名 → 编辑器 hydrate 出 expectedText。
 */
async function openDocumentAndWaitReady(
  window: Page,
  options: { pageName: string; expectedText: string },
) {
  await clickTreeItem(window, options.pageName);
  await expect(window.getByRole("textbox", { name: "文档标题" })).toHaveValue(
    options.pageName,
    { timeout: UI_TIMEOUT },
  );
  const editor = window.locator(".editor__content .ProseMirror");
  await expect(editor).toContainText(options.expectedText, {
    timeout: UI_TIMEOUT,
  });
  return editor;
}

/** 打开版本历史面板（EditorShell 顶栏「版本历史」按钮 → Dialog）。 */
async function openVersionPanel(window: Page) {
  await window.getByRole("button", { name: "版本历史" }).click();
  const panel = window.getByRole("dialog", { name: "版本历史" });
  await expect(panel).toBeVisible({ timeout: UI_TIMEOUT });
  return panel;
}

/** 全选编辑器正文并整体替换为 text，等待自动保存落盘。 */
async function replaceBodyAndWaitSaved(
  window: Page,
  absFile: string,
  text: string,
) {
  const editor = window.locator(".editor__content .ProseMirror");
  await editor.click();
  await window.keyboard.press("Meta+A");
  await window.keyboard.type(text);
  await expect(window.getByText(/已保存/)).toBeVisible({ timeout: UI_TIMEOUT });
  await expect
    .poll(async () => readFile(absFile, "utf8"), { timeout: UI_TIMEOUT })
    .toContain(text);
}

/** 知识库首页 →「重新扫描」：raw IPC 文件操作后强制 Renderer 刷新树。 */
async function rescanViaUi(window: Page) {
  await window.getByRole("button", { name: "首页" }).click();
  await window.getByRole("button", { name: "重新扫描" }).click();
}

/** 面板内经二次确认恢复「摘要含 snippet 的版本」，成功后面板自动关闭。 */
async function restoreViaPanel(window: Page, snippet: string) {
  const panel = await openVersionPanel(window);
  const summary = panel.locator(".version-panel__summary", {
    hasText: snippet,
  });
  await expect(summary).toBeVisible({ timeout: UI_TIMEOUT });
  await summary.click();
  // lazy get 加载完整快照后才出现恢复按钮。
  const restore = panel.getByRole("button", { name: "恢复此版本" });
  await expect(restore).toBeVisible({ timeout: UI_TIMEOUT });
  await restore.click();
  await panel.getByRole("button", { name: "确认恢复？" }).click();
  await expect(panel).toHaveCount(0, { timeout: UI_TIMEOUT });
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    await access(abs);
    return true;
  } catch {
    return false;
  }
}

/** `.e1/revisions/series/` 下的 series 目录名列表（目录缺失为空数组）。 */
async function seriesDirs(vaultDir: string): Promise<string[]> {
  return readdir(path.join(vaultDir, ".e1", "revisions", "series")).catch(
    () => [] as string[],
  );
}

test.describe("桌面冒烟：R012 版本历史（G44–G56）", () => {
  test.beforeAll(() => {
    requireDesktopArtifacts();
  });

  test("@golden G44：自动保存后 interval 版本可读取；节流与模拟到期", async () => {
    const id = "01JE2EREV0000000000001";
    const fixture = await createFixture([
      ["自动.md", note(id, "自动页", "初始正文。")],
    ]);
    const abs = path.join(fixture.vaultDir, "自动.md");
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      await openDocumentAndWaitReady(window, {
        pageName: "自动页",
        expectedText: "初始正文。",
      });

      // 首次成功保存即创建 interval 版本（lastIntervalAt=null，无需等 5min）。
      const editor = window.locator(".editor__content .ProseMirror");
      await editor.click();
      await window.keyboard.type("第一段自动保存。");
      await expect(window.getByText(/已保存/)).toBeVisible({
        timeout: UI_TIMEOUT,
      });
      await expect
        .poll(async () => readFile(abs, "utf8"), { timeout: UI_TIMEOUT })
        .toContain("第一段自动保存。");
      // 维护任务（revision.add + prune）跟随保存成功异步执行。
      await expect
        .poll(
          async () =>
            (await listRevisions(window, "自动.md", id))?.filter(
              (s) => s.reason === "interval",
            ).length ?? -1,
          { timeout: UI_TIMEOUT },
        )
        .toBe(1);
      // 快照真实落盘（.e1/revisions/series/<seriesId>/...）。
      expect(await seriesDirs(fixture.vaultDir)).toHaveLength(1);

      // 5min 节流：第二次保存不产生新 interval 版本。
      await editor.click();
      await window.keyboard.type("第二段自动保存。");
      await expect(window.getByText(/已保存/)).toBeVisible({
        timeout: UI_TIMEOUT,
      });
      await expect
        .poll(async () => readFile(abs, "utf8"), { timeout: UI_TIMEOUT })
        .toContain("第二段自动保存。");
      await window.waitForTimeout(500);
      const afterSecond = await listRevisions(window, "自动.md", id);
      expect(afterSecond?.filter((s) => s.reason === "interval")).toHaveLength(
        1,
      );

      // 模拟节流到期：IPC 直调 capture(reason:"interval")（Main 重读磁盘，
      // 当前 body 与上一快照不同 → 新快照；interval 总数变 2）。
      const captured = await captureRevision(window, {
        relativePath: "自动.md",
        stableNoteId: id,
        reason: "interval",
      });
      expect(captured?.reason).toBe("interval");
      const finalList = await listRevisions(window, "自动.md", id);
      expect(finalList?.filter((s) => s.reason === "interval")).toHaveLength(2);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G45：手动创建版本 → 重启后仍存在", async () => {
    const id = "01JE2EREV0000000000011";
    const fixture = await createFixture([
      ["重启.md", note(id, "重启页", "重启前正文。")],
    ]);
    const app1 = await launch(fixture.userDataDir);
    try {
      const window = await app1.firstWindow();
      await waitAppReady(window);
      await openDocumentAndWaitReady(window, {
        pageName: "重启页",
        expectedText: "重启前正文。",
      });
      const panel = await openVersionPanel(window);
      await panel.getByRole("button", { name: "创建版本" }).click();
      await expect(panel.locator(".version-panel__item")).toHaveCount(1, {
        timeout: UI_TIMEOUT,
      });
      await expect(
        panel.locator(".version-panel__reason", { hasText: "手动" }),
      ).toBeVisible();
      await expect(panel).toContainText("重启前正文。");
      expect(await listRevisions(window, "重启.md", id)).toHaveLength(1);
    } finally {
      await app1.close();
    }

    // 重启（同 userData + 同 Vault）：历史来自 .e1/revisions 磁盘快照。
    const app2 = await launch(fixture.userDataDir);
    try {
      const window = await app2.firstWindow();
      await waitAppReady(window);
      await openDocumentAndWaitReady(window, {
        pageName: "重启页",
        expectedText: "重启前正文。",
      });
      const panel = await openVersionPanel(window);
      await expect(panel.locator(".version-panel__item")).toHaveCount(1, {
        timeout: UI_TIMEOUT,
      });
      await expect(
        panel.locator(".version-panel__reason", { hasText: "手动" }),
      ).toBeVisible();
      const summaries = await listRevisions(window, "重启.md", id);
      expect(summaries).toHaveLength(1);
      expect(summaries?.[0].reason).toBe("manual");
      expect(summaries?.[0].textPreview).toContain("重启前正文。");
    } finally {
      await app2.close();
      await fixture.cleanup();
    }
  });

  test("@golden G46：VersionPanel lazy preview——列表不含正文，展开才出预览", async () => {
    const id = "01JE2EREV0000000000021";
    // 尾部标记放在 40 字摘要截断点之后（UI slice(0,40)，manifest
    // textPreview 上限 200 字），列表绝不可见、展开预览才可见。
    const bodyA = `甲版开头标记。${"中".repeat(40)}甲版尾部独特标记。`;
    const bodyB = `乙版开头标记。${"中".repeat(40)}乙版尾部独特标记。`;
    const fixture = await createFixture([
      ["预览.md", note(id, "预览页", bodyA)],
    ]);
    const abs = path.join(fixture.vaultDir, "预览.md");
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      // 两条 manual 快照：A（旧）与 B（新，外部改写后捕获）。
      await captureRevision(window, {
        relativePath: "预览.md",
        stableNoteId: id,
        reason: "manual",
      });
      await writeFile(abs, note(id, "预览页", bodyB), "utf8");
      await captureRevision(window, {
        relativePath: "预览.md",
        stableNoteId: id,
        reason: "manual",
      });

      await openDocumentAndWaitReady(window, {
        pageName: "预览页",
        expectedText: "乙版开头标记。",
      });
      const panel = await openVersionPanel(window);
      // summary 列表只有时间/原因/大小/40 字摘要：两条都列出，
      // 但完整正文的尾部标记不在 DOM 中，且没有任何预览块。
      await expect(panel.locator(".version-panel__item")).toHaveCount(2, {
        timeout: UI_TIMEOUT,
      });
      await expect(panel).toContainText("乙版开头标记。");
      expect(await panel.textContent()).not.toContain("乙版尾部独特标记");
      expect(await panel.textContent()).not.toContain("甲版尾部独特标记");
      await expect(panel.locator(".version-panel__preview")).toHaveCount(0);

      // 展开最新版本 → lazy get 取回完整 raw body，尾部标记出现。
      await panel
        .locator(".version-panel__summary", { hasText: "乙版开头标记。" })
        .click();
      await expect(panel.locator(".version-panel__preview")).toHaveCount(1);
      await expect(panel.locator(".version-panel__text")).toContainText(
        "乙版尾部独特标记。",
        { timeout: UI_TIMEOUT },
      );
      // 另一条的正文仍未加载（lazy 语义不被展开一条破坏）。
      expect(await panel.textContent()).not.toContain("甲版尾部独特标记");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G47：恢复正文 → title/tags/id/文件名/树标题不变", async () => {
    const id = "01JE2EREV0000000000031";
    const fixture = await createFixture([
      ["版本页.md", noteWithTags(id, "版本页", "[历史]", "第一版正文。")],
    ]);
    const abs = path.join(fixture.vaultDir, "版本页.md");
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      const editor = await openDocumentAndWaitReady(window, {
        pageName: "版本页",
        expectedText: "第一版正文。",
      });
      // 手动版本锁定 v1 正文。
      const panel = await openVersionPanel(window);
      await panel.getByRole("button", { name: "创建版本" }).click();
      await expect(panel.locator(".version-panel__item")).toHaveCount(1, {
        timeout: UI_TIMEOUT,
      });
      await window.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);

      // 编辑为 v2 并落盘。
      await replaceBodyAndWaitSaved(window, abs, "第二版正文。");
      await expect(editor).toContainText("第二版正文。");

      // 面板恢复 v1（二次确认），成功后面板自动关闭、编辑器重建。
      await restoreViaPanel(window, "第一版正文。");
      await expect(editor).toContainText("第一版正文。", {
        timeout: UI_TIMEOUT,
      });
      await expect(editor).not.toContainText("第二版正文。");

      // REV-01/REV-03：只恢复正文——Frontmatter 与物理路径不变。
      await expect
        .poll(async () => readFile(abs, "utf8"), { timeout: UI_TIMEOUT })
        .toContain("第一版正文。");
      const disk = await readFile(abs, "utf8");
      expect(disk).not.toContain("第二版正文。");
      expect(disk).toContain(`id: ${id}`);
      expect(disk).toContain("title: 版本页");
      expect(disk).toContain("tags: [历史]");
      expect(await fileExists(abs)).toBe(true);
      // 树标题不变（title 未被恢复改写）。
      await expect(
        window.getByRole("treeitem", { name: /版本页/ }),
      ).toBeVisible();
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G48：before-restore 安全快照可再次恢复回去", async () => {
    const id = "01JE2EREV0000000000041";
    const fixture = await createFixture([
      ["回滚.md", note(id, "回滚页", "第一版回滚正文。")],
    ]);
    const abs = path.join(fixture.vaultDir, "回滚.md");
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      const editor = await openDocumentAndWaitReady(window, {
        pageName: "回滚页",
        expectedText: "第一版回滚正文。",
      });
      const panel = await openVersionPanel(window);
      await panel.getByRole("button", { name: "创建版本" }).click();
      await expect(panel.locator(".version-panel__item")).toHaveCount(1, {
        timeout: UI_TIMEOUT,
      });
      await window.keyboard.press("Escape");

      await replaceBodyAndWaitSaved(window, abs, "第二版回滚正文。");
      // 再编辑出一段「已保存但未被任何快照收录」的正文：首次保存已创建
      // interval 快照（节流 5min 内第二次保存不再创建），若不做这一步，
      // 恢复时的 before-restore 捕获会因与 interval 快照同 body 被去重，
      // 面板里不会出现「恢复前」条目（§19 dedupe）。
      await replaceBodyAndWaitSaved(
        window,
        abs,
        "第二版回滚正文。追加未快照段落。",
      );
      // 恢复到 v1（协调器先把当前 v2' 存为 before-restore 快照）。
      await restoreViaPanel(window, "第一版回滚正文。");
      await expect(editor).toContainText("第一版回滚正文。", {
        timeout: UI_TIMEOUT,
      });

      // 再次打开面板：存在「恢复前」条目（v2'），恢复它即回到 v2'。
      const panel2 = await openVersionPanel(window);
      const beforeRestoreItem = panel2
        .locator(".version-panel__item")
        .filter({ hasText: "恢复前" });
      await expect(beforeRestoreItem).toHaveCount(1, { timeout: UI_TIMEOUT });
      await expect(beforeRestoreItem).toContainText("追加未快照段落。");
      await beforeRestoreItem.locator(".version-panel__summary").click();
      const restore = panel2.getByRole("button", { name: "恢复此版本" });
      await expect(restore).toBeVisible({ timeout: UI_TIMEOUT });
      await restore.click();
      await panel2.getByRole("button", { name: "确认恢复？" }).click();
      await expect(panel2).toHaveCount(0, { timeout: UI_TIMEOUT });
      await expect(editor).toContainText("第二版回滚正文。追加未快照段落。", {
        timeout: UI_TIMEOUT,
      });
      await expect
        .poll(async () => readFile(abs, "utf8"), { timeout: UI_TIMEOUT })
        .toContain("第二版回滚正文。追加未快照段落。");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G49：外部编辑导致版本令牌失配 → restore 冲突且不覆盖磁盘", async () => {
    const id = "01JE2EREV0000000000051";
    const fixture = await createFixture([
      ["冲突.md", note(id, "冲突页", "版本一正文。")],
    ]);
    const abs = path.join(fixture.vaultDir, "冲突.md");
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      // 捕获 v1 快照。
      const captured = await captureRevision(window, {
        relativePath: "冲突.md",
        stableNoteId: id,
        reason: "manual",
      });
      expect(captured).not.toBeNull();
      const tokenBefore = (await window.evaluate(
        async ({ vaultId, rel }) => {
          const e1 = (window as unknown as { e1?: E1Bridge }).e1;
          return (await e1!.note!.read({ vaultId, relativePath: rel }))
            .versionToken;
        },
        { vaultId: VAULT_ID, rel: "冲突.md" },
      )) as string;

      // 外部程序改写磁盘（版本令牌随之改变）。
      await writeFile(abs, note(id, "冲突页", "外部改写正文。"), "utf8");

      // 持旧令牌恢复 → DOCUMENT_CONFLICT，磁盘一个字节都不写。
      const failure = await window.evaluate(
        async ({ vaultId, rel, sid, revisionId, token }) => {
          const e1 = (window as unknown as { e1?: E1Bridge }).e1;
          try {
            await e1!.revisions!.restore({
              vaultId,
              relativePath: rel,
              stableNoteId: sid,
              revisionId,
              expectedVersionToken: token,
            });
            return { ok: true as const, message: "" };
          } catch (err) {
            return {
              ok: false as const,
              message: err instanceof Error ? err.message : String(err),
            };
          }
        },
        {
          vaultId: VAULT_ID,
          rel: "冲突.md",
          sid: id,
          revisionId: captured!.revisionId,
          token: tokenBefore,
        },
      );
      expect(failure.ok).toBe(false);
      expect(failure.message).toMatch(/CONFLICT|之外发生修改/);
      // 外部内容不被覆盖（历史正文没有写回）。
      const disk = await readFile(abs, "utf8");
      expect(disk).toContain("外部改写正文。");
      expect(disk).not.toContain("版本一正文。");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G50：Document rename → 历史仍属于同一 stable note", async () => {
    const id = "01JE2EREV0000000000061";
    const fixture = await createFixture([
      ["原稿.md", note(id, "原稿页", "原稿历史正文。")],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      await waitLinksReady(window);
      await captureRevision(window, {
        relativePath: "原稿.md",
        stableNoteId: id,
        reason: "manual",
      });

      // 物理改名（与 G31 同口径；plan 需要链接索引 ready）。
      const renamed = await window.evaluate(async (vaultId) => {
        const e1 = (window as unknown as { e1?: E1Bridge }).e1;
        const plan = await e1!.fileOperation!.plan({
          kind: "rename-document-file",
          vaultId,
          fromRelativePath: "原稿.md",
          newName: "新稿.md",
        });
        await e1!.fileOperation!.execute({ vaultId, plan });
        // 与 DesktopFileOperationService 成功后的 revision.relocate 一致
        //（Renderer 编排由单测锁定；此处直验 IPC + Store 语义）。
        return e1!.revisions!.relocate({
          vaultId,
          stableNoteId: "01JE2EREV0000000000061",
          fromRelativePath: "原稿.md",
          toRelativePath: "新稿.md",
        });
      }, VAULT_ID);
      expect(renamed.relocated).toBe(1);
      expect(await fileExists(path.join(fixture.vaultDir, "新稿.md"))).toBe(
        true,
      );

      // stable-id 定位：新路径下列表仍在；series 当前路径元数据已搬迁。
      const summaries = await listRevisions(window, "新稿.md", id);
      expect(summaries).toHaveLength(1);
      expect(summaries?.[0].textPreview).toContain("原稿历史正文。");
      const [seriesId] = await seriesDirs(fixture.vaultDir);
      const series = JSON.parse(
        await readFile(
          path.join(
            fixture.vaultDir,
            ".e1",
            "revisions",
            "series",
            seriesId,
            "series.json",
          ),
          "utf8",
        ),
      ) as { stableNoteId: string; currentRelativePath: string };
      expect(series.stableNoteId).toBe(id);
      expect(series.currentRelativePath).toBe("新稿.md");

      // UI 口径：改名后打开文档（title 不变），面板仍列出版本。
      // raw IPC 执行不触发 Renderer 侧 scans.invalidate（DesktopFileOperation-
      // Service 的职责），先经「重新扫描」刷新树再点开文档。
      await rescanViaUi(window);
      await openDocumentAndWaitReady(window, {
        pageName: "原稿页",
        expectedText: "原稿历史正文。",
      });
      const panel = await openVersionPanel(window);
      await expect(panel.locator(".version-panel__item")).toHaveCount(1, {
        timeout: UI_TIMEOUT,
      });
      await expect(panel).toContainText("原稿历史正文。");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G51：Group rename → 子文档历史仍可访问", async () => {
    // 步骤多（链接索引 ready + 文件操作 + 重新扫描 + 面板），放宽全局 30s 上限。
    test.setTimeout(60_000);
    const id = "01JE2EREV0000000000071";
    const fixture = await createFixture([
      ["组/子页.md", note(id, "组内子页", "组内历史正文。")],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      await waitLinksReady(window);
      await captureRevision(window, {
        relativePath: "组/子页.md",
        stableNoteId: id,
        reason: "manual",
      });

      const result = await window.evaluate(async (vaultId) => {
        const e1 = (window as unknown as { e1?: E1Bridge }).e1;
        const plan = await e1!.fileOperation!.plan({
          kind: "rename-group",
          vaultId,
          fromRelativePath: "组",
          newName: "新组",
        });
        await e1!.fileOperation!.execute({ vaultId, plan });
        // 分组前缀搬迁（DesktopFileOperationService prefix=true 同语义）。
        return e1!.revisions!.relocate({
          vaultId,
          fromRelativePath: "组",
          toRelativePath: "新组",
          prefix: true,
        });
      }, VAULT_ID);
      expect(result.relocated).toBe(1);
      expect(
        await fileExists(path.join(fixture.vaultDir, "新组", "子页.md")),
      ).toBe(true);

      const summaries = await listRevisions(window, "新组/子页.md", id);
      expect(summaries).toHaveLength(1);
      expect(summaries?.[0].textPreview).toContain("组内历史正文。");
      const [seriesId] = await seriesDirs(fixture.vaultDir);
      const series = JSON.parse(
        await readFile(
          path.join(
            fixture.vaultDir,
            ".e1",
            "revisions",
            "series",
            seriesId,
            "series.json",
          ),
          "utf8",
        ),
      ) as { currentRelativePath: string };
      expect(series.currentRelativePath).toBe("新组/子页.md");

      // UI 口径：子文档面板可列出（raw IPC 执行不刷新树，先重新扫描）。
      // 分组 id 随路径变化，重扫后不在 collapsed 集合里（默认展开）；
      // 若实际处于折叠态则先点「展开」。
      await rescanViaUi(window);
      const groupRow = treeItem(window, "新组");
      await expect(groupRow).toBeVisible({ timeout: UI_TIMEOUT });
      const expandButton = groupRow.getByRole("button", { name: "展开" });
      if ((await expandButton.count()) > 0) {
        await expandButton.click();
      }
      await openDocumentAndWaitReady(window, {
        pageName: "组内子页",
        expectedText: "组内历史正文。",
      });
      const panel = await openVersionPanel(window);
      await expect(panel.locator(".version-panel__item")).toHaveCount(1, {
        timeout: UI_TIMEOUT,
      });
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G52：Trash → Restore → 历史仍存在", async () => {
    const id = "01JE2EREV0000000000081";
    const fixture = await createFixture([
      ["回收页.md", note(id, "回收页", "回收历史正文。")],
    ]);
    const abs = path.join(fixture.vaultDir, "回收页.md");
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      await openDocumentAndWaitReady(window, {
        pageName: "回收页",
        expectedText: "回收历史正文。",
      });
      const panel = await openVersionPanel(window);
      await panel.getByRole("button", { name: "创建版本" }).click();
      await expect(panel.locator(".version-panel__item")).toHaveCount(1, {
        timeout: UI_TIMEOUT,
      });
      await window.keyboard.press("Escape");
      expect(await seriesDirs(fixture.vaultDir)).toHaveLength(1);

      // 移入回收站（UI 行内动作，与 G08 同口径）：正文进 .e1/trash，
      // 历史快照一律保留（§25）。
      const tree = window.getByRole("tree", { name: "页面树" });
      await tree.getByText("回收页").hover();
      await window.getByLabel("删除「回收页」").click();
      await expect(tree).not.toContainText("回收页", { timeout: UI_TIMEOUT });
      await expect
        .poll(async () => fileExists(abs), { timeout: UI_TIMEOUT })
        .toBe(false);
      expect(await seriesDirs(fixture.vaultDir)).toHaveLength(1);

      // 回收站恢复：历史仍属于同一 stable note。
      await window.getByLabel("回收站", { exact: true }).click();
      const trashPanel = window.getByRole("dialog", { name: "回收站" });
      await expect(trashPanel).toContainText("回收页");
      await trashPanel.getByText("回收页", { exact: true }).hover();
      await trashPanel.getByLabel("恢复「回收页」").click();
      await expect(trashPanel.getByText("回收站是空的。")).toBeVisible({
        timeout: UI_TIMEOUT,
      });
      await expect
        .poll(async () => fileExists(abs), { timeout: UI_TIMEOUT })
        .toBe(true);
      expect(await seriesDirs(fixture.vaultDir)).toHaveLength(1);
      const summaries = await listRevisions(window, "回收页.md", id);
      expect(summaries).toHaveLength(1);
      expect(summaries?.[0].reason).toBe("manual");

      // UI 口径：恢复后打开文档，面板仍列出版本。
      await window.keyboard.press("Escape");
      await openDocumentAndWaitReady(window, {
        pageName: "回收页",
        expectedText: "回收历史正文。",
      });
      const panel2 = await openVersionPanel(window);
      await expect(panel2.locator(".version-panel__item")).toHaveCount(1, {
        timeout: UI_TIMEOUT,
      });
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G53：Purge → revision series 物理删除", async () => {
    const id = "01JE2EREV0000000000091";
    const fixture = await createFixture([
      ["清除页.md", note(id, "清除页", "清除历史正文。")],
    ]);
    const abs = path.join(fixture.vaultDir, "清除页.md");
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      await openDocumentAndWaitReady(window, {
        pageName: "清除页",
        expectedText: "清除历史正文。",
      });
      const panel = await openVersionPanel(window);
      await panel.getByRole("button", { name: "创建版本" }).click();
      await expect(panel.locator(".version-panel__item")).toHaveCount(1, {
        timeout: UI_TIMEOUT,
      });
      await window.keyboard.press("Escape");
      expect(await seriesDirs(fixture.vaultDir)).toHaveLength(1);

      // 移入回收站后「彻底删除」（二次点击确认）——走 Renderer
      // DesktopPageRepository.purge → purgeRevisionSeries 接线（§25）。
      const tree = window.getByRole("tree", { name: "页面树" });
      await tree.getByText("清除页").hover();
      await window.getByLabel("删除「清除页」").click();
      await expect(tree).not.toContainText("清除页", { timeout: UI_TIMEOUT });
      await window.getByLabel("回收站", { exact: true }).click();
      const trashPanel = window.getByRole("dialog", { name: "回收站" });
      await expect(trashPanel).toContainText("清除页");
      await trashPanel.getByText("清除页", { exact: true }).hover();
      await trashPanel.getByLabel("彻底删除「清除页」").click();
      await trashPanel.getByLabel("彻底删除「清除页」").click();
      await expect(trashPanel.getByText("回收站是空的。")).toBeVisible({
        timeout: UI_TIMEOUT,
      });

      // 正文永久删除 + revision series 物理清除（manifest/body 一并消失）。
      await expect
        .poll(async () => seriesDirs(fixture.vaultDir), { timeout: UI_TIMEOUT })
        .toHaveLength(0);
      expect(await fileExists(abs)).toBe(false);
      const summaries = await listRevisions(window, "清除页.md", id);
      expect(summaries).toHaveLength(0);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G54：CRLF 文档 restore 后磁盘仍为 CRLF（source 保持）", async () => {
    const id = "01JE2EREV00000000000A1";
    const crlfNote = (body: string) =>
      ["---", `id: ${id}`, "title: CRLF页", "---", "", body, ""].join("\r\n");
    const fixture = await createFixture([
      ["换行.md", crlfNote("第一行甲。\r\n第二行乙。")],
    ]);
    const abs = path.join(fixture.vaultDir, "换行.md");
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      // 捕获 CRLF 快照：manifest 记录 lineEnding=crlf，body 逐字节原样。
      const captured = await captureRevision(window, {
        relativePath: "换行.md",
        stableNoteId: id,
        reason: "manual",
      });
      expect(captured).not.toBeNull();
      const snapshot = await window.evaluate(
        async ({ vaultId, rel, sid, revisionId }) => {
          const e1 = (window as unknown as { e1?: E1Bridge }).e1;
          return e1!.revisions!.get({
            vaultId,
            relativePath: rel,
            stableNoteId: sid,
            revisionId,
          });
        },
        {
          vaultId: VAULT_ID,
          rel: "换行.md",
          sid: id,
          revisionId: captured!.revisionId,
        },
      );
      expect(snapshot?.lineEnding).toBe("crlf");
      expect(snapshot?.body).toContain("\r\n");
      expect(snapshot?.body).toContain("第一行甲。");

      // 外部改写为新的 CRLF 内容，再恢复历史版本。
      await writeFile(abs, crlfNote("外部第二版。"), "utf8");
      const token = (await window.evaluate(
        async ({ vaultId, rel }) => {
          const e1 = (window as unknown as { e1?: E1Bridge }).e1;
          return (await e1!.note!.read({ vaultId, relativePath: rel }))
            .versionToken;
        },
        { vaultId: VAULT_ID, rel: "换行.md" },
      )) as string;
      await window.evaluate(
        async ({ vaultId, rel, sid, revisionId, expectedVersionToken }) => {
          const e1 = (window as unknown as { e1?: E1Bridge }).e1;
          await e1!.revisions!.restore({
            vaultId,
            relativePath: rel,
            stableNoteId: sid,
            revisionId,
            expectedVersionToken,
          });
        },
        {
          vaultId: VAULT_ID,
          rel: "换行.md",
          sid: id,
          revisionId: captured!.revisionId,
          expectedVersionToken: token,
        },
      );

      // 磁盘：历史正文回来、外部内容消失、Frontmatter 保留、全程无孤立 LF。
      const disk = await readFile(abs, "utf8");
      expect(disk).toContain("第一行甲。");
      expect(disk).not.toContain("外部第二版。");
      expect(disk).toContain(`id: ${id}`);
      expect(disk).toContain("title: CRLF页");
      expect(disk.includes("\r\n")).toBe(true);
      expect(/(?<!\r)\n/.test(disk)).toBe(false);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G55：含内部链接文档 restore → LinkIndex/backlink 恢复正确", async () => {
    const sourceId = "01JE2EREV00000000000B1";
    const targetId = "01JE2EREV00000000000B2";
    const fixture = await createFixture([
      ["源.md", note(sourceId, "源页", "参考 [目标页](目标.md)。")],
      ["目标.md", note(targetId, "目标页", "目标正文。")],
    ]);
    const sourceAbs = path.join(fixture.vaultDir, "源.md");
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      await waitLinksReady(window);
      const editor = await openDocumentAndWaitReady(window, {
        pageName: "源页",
        expectedText: "参考",
      });
      // 手动版本锁定「含链接」的正文。
      const panel = await openVersionPanel(window);
      await panel.getByRole("button", { name: "创建版本" }).click();
      await expect(panel.locator(".version-panel__item")).toHaveCount(1, {
        timeout: UI_TIMEOUT,
      });
      await window.keyboard.press("Escape");

      // 编辑移除链接并落盘：出边/反向链接随之清零（保存自写钩子 upsert）。
      await replaceBodyAndWaitSaved(window, sourceAbs, "链接已移除。");
      await expect
        .poll(async () => backlinkCount(window, targetId), {
          timeout: UI_TIMEOUT,
        })
        .toBe(0);

      // 恢复含链接版本：DesktopRevisionRestoreService 显式 reconcile
      // LinkIndex（不依赖 watcher），backlink/outgoing 立即恢复。
      await restoreViaPanel(window, "目标页");
      await expect(
        editor.locator("span.internal-link", { hasText: "目标页" }),
      ).toBeVisible({ timeout: UI_TIMEOUT });
      await expect
        .poll(async () => readFile(sourceAbs, "utf8"), { timeout: UI_TIMEOUT })
        .toContain("[目标页](目标.md)");
      await expect
        .poll(async () => backlinkCount(window, targetId), {
          timeout: UI_TIMEOUT,
        })
        .toBe(1);
      const outgoing = await window.evaluate(async (vaultId) => {
        const e1 = (window as unknown as { e1?: E1Bridge }).e1;
        return e1!.links!.outgoing({
          vaultId,
          noteKey: "01JE2EREV00000000000B1",
        });
      }, VAULT_ID);
      expect(
        outgoing.some(
          (link) =>
            link.targetRelativePath === "目标.md" && link.broken === false,
        ),
      ).toBe(true);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G56：restore 后全文搜索立即命中新正文", async () => {
    const id = "01JE2EREV00000000000C1";
    const fixture = await createFixture([
      ["检索.md", note(id, "检索页", "琥珀独特词甲 第一版。")],
    ]);
    const abs = path.join(fixture.vaultDir, "检索.md");
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      await waitSearchReady(window);
      await openDocumentAndWaitReady(window, {
        pageName: "检索页",
        expectedText: "琥珀独特词甲",
      });
      const panel = await openVersionPanel(window);
      await panel.getByRole("button", { name: "创建版本" }).click();
      await expect(panel.locator(".version-panel__item")).toHaveCount(1, {
        timeout: UI_TIMEOUT,
      });
      await window.keyboard.press("Escape");

      // 编辑去掉独特词并落盘：搜索索引同步，旧词不再命中该文档。
      await replaceBodyAndWaitSaved(window, abs, "第二版没有那个词。");
      await expect
        .poll(
          async () =>
            (await searchHits(window, "琥珀独特词甲"))?.filter(
              (hit) => hit.stableNoteId === id,
            ).length ?? -1,
          { timeout: UI_TIMEOUT },
        )
        .toBe(0);

      // 恢复含独特词的版本：SearchIndex 显式 reconcile，立即重新命中。
      await restoreViaPanel(window, "琥珀独特词甲");
      await expect
        .poll(
          async () =>
            (await searchHits(window, "琥珀独特词甲"))?.some(
              (hit) =>
                hit.stableNoteId === id && hit.relativePath === "检索.md",
            ) ?? false,
          { timeout: UI_TIMEOUT },
        )
        .toBe(true);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });
});
