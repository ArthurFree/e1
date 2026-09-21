// R015.1：知识图谱 Desktop Golden G72–G83。
// describe 以「桌面冒烟」为前缀；禁止 force: true。
import { test, expect, _electron as electron } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requireDesktopArtifacts } from "./desktopArtifacts";
import { waitDesktopWorkspaceReady, waitDocumentReady } from "./desktopReady";
import { clickTreeItem } from "./tree";

const VAULT_ID = "v-e2e-graph";
const LINK_TIMEOUT = 15_000;
const WATCHER_READY_MS = 800;
const UI_TIMEOUT = 15_000;

interface GraphFixture {
  vaultDir: string;
  userDataDir: string;
  cleanup(): Promise<void>;
}

async function createFixture(
  files: Array<[string, string]>,
): Promise<GraphFixture> {
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "e1-vault-graph-"));
  for (const [rel, content] of files) {
    const abs = path.join(vaultDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  await mkdir(path.join(vaultDir, ".e1"));
  await writeFile(
    path.join(vaultDir, ".e1", "vault.json"),
    JSON.stringify({
      format: "e1-vault",
      formatVersion: 1,
      vaultId: VAULT_ID,
      name: path.basename(vaultDir),
      createdAt: "2026-09-10T00:00:00.000Z",
      assetsDirectory: "assets",
      identityMode: "frontmatter",
    }),
  );
  const userDataDir = await mkdtemp(
    path.join(os.tmpdir(), "e1-userdata-graph-"),
  );
  await writeFile(
    path.join(userDataDir, "recent-vaults.json"),
    JSON.stringify([
      {
        vaultId: VAULT_ID,
        absolutePath: vaultDir,
        displayName: path.basename(vaultDir),
        lastOpenedAt: "2026-09-10T00:00:00.000Z",
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

function note(
  id: string,
  title: string,
  body: string,
  extra: string[] = [],
): string {
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    ...extra,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

interface GraphProjectionDto {
  nodes: Array<{ id: string; title: string }>;
  edges: Array<{ state: string; targetId: string | null }>;
  truncated: boolean;
  centerNodeId?: string;
}

function graphOf(window: Page) {
  return {
    neighborhood: (noteKey: string, depth: 1 | 2, nodeLimit = 80) =>
      window.evaluate(
        async ({ vaultId, noteKey: key, depth: d, nodeLimit: limit }) => {
          const e1 = (
            window as unknown as {
              e1?: {
                graph?: {
                  neighborhood(input: {
                    vaultId: string;
                    noteKey: string;
                    depth: 1 | 2;
                    nodeLimit: number;
                    edgeLimit: number;
                    includeBroken: boolean;
                  }): Promise<GraphProjectionDto>;
                };
                links?: {
                  status(input: {
                    vaultId: string;
                  }): Promise<{ state: string }>;
                };
              };
            }
          ).e1;
          return e1?.graph?.neighborhood({
            vaultId,
            noteKey: key,
            depth: d,
            nodeLimit: limit,
            edgeLimit: 160,
            includeBroken: true,
          });
        },
        { vaultId: VAULT_ID, noteKey, depth, nodeLimit },
      ),
    workspace: (filters: Record<string, unknown>, nodeLimit = 200) =>
      window.evaluate(
        async ({ vaultId, filters: f, nodeLimit: limit }) => {
          const e1 = (
            window as unknown as {
              e1?: {
                graph?: {
                  workspace(input: {
                    vaultId: string;
                    nodeLimit: number;
                    edgeLimit: number;
                    filters?: Record<string, unknown>;
                  }): Promise<GraphProjectionDto>;
                };
              };
            }
          ).e1;
          return e1?.graph?.workspace({
            vaultId,
            nodeLimit: limit,
            edgeLimit: 500,
            filters: f,
          });
        },
        { vaultId: VAULT_ID, filters, nodeLimit },
      ),
    linkStatus: () =>
      window.evaluate(async (vaultId) => {
        const e1 = (
          window as unknown as {
            e1?: {
              links?: {
                status(input: { vaultId: string }): Promise<{ state: string }>;
              };
            };
          }
        ).e1;
        return (await e1?.links?.status({ vaultId }))?.state ?? null;
      }, VAULT_ID),
  };
}

async function waitLinkIndexReady(window: Page) {
  await expect
    .poll(async () => graphOf(window).linkStatus(), { timeout: LINK_TIMEOUT })
    .toBe("ready");
}

async function insertInternalLink(window: Page, targetTitle: string) {
  const editor = window.locator(".editor__content .ProseMirror");
  await editor.click();
  await window.keyboard.type(" @");
  const option = window.getByRole("option", { name: targetTitle });
  await expect(option).toBeVisible({ timeout: 5000 });
  await option.click();
  await expect(
    editor.locator("span.internal-link", { hasText: targetTitle }),
  ).toBeVisible();
}

async function replaceBodyAndWaitSaved(
  window: Page,
  absFile: string,
  text: string,
) {
  const editor = window.locator(".editor__content .ProseMirror");
  await editor.click();
  await window.keyboard.press("ControlOrMeta+A");
  await window.keyboard.type(text);
  await expect(window.getByText(/已保存/)).toBeVisible({ timeout: UI_TIMEOUT });
  await expect
    .poll(async () => readFile(absFile, "utf8"), { timeout: UI_TIMEOUT })
    .toContain(text);
}

async function restoreViaPanel(window: Page, snippet: string) {
  await window.getByRole("button", { name: "版本历史" }).click();
  const panel = window.getByRole("dialog", { name: "版本历史" });
  await expect(panel).toBeVisible({ timeout: UI_TIMEOUT });
  const item = panel
    .locator(".version-panel__item")
    .filter({ hasText: snippet })
    .filter({ hasText: "手动" });
  await expect(item).toHaveCount(1, { timeout: UI_TIMEOUT });
  await item.locator(".version-panel__summary").click();
  const restore = item.getByRole("button", { name: "恢复此版本" });
  await expect(restore).toBeVisible({ timeout: UI_TIMEOUT });
  await restore.click();
  await item.getByRole("button", { name: "确认恢复？" }).click();
  await expect(panel).toHaveCount(0, { timeout: UI_TIMEOUT });
}

const CENTER = "01JE2EGRAPH00000000001";
const OUT = "01JE2EGRAPH00000000002";
const IN = "01JE2EGRAPH00000000003";
const HOP2 = "01JE2EGRAPH00000000004";
const ORPHAN = "01JE2EGRAPH00000000005";
const TAGGED = "01JE2EGRAPH00000000006";

function relationFiles(): Array<[string, string]> {
  return [
    [
      "中心.md",
      note(CENTER, "中心页", "指向 [出站页](出站.md) 与 [缺失](缺失.md)。"),
    ],
    ["出站.md", note(OUT, "出站页", "再指向 [二跳页](二跳.md)。")],
    ["来源.md", note(IN, "来源页", "回指 [中心页](中心.md)。")],
    ["二跳.md", note(HOP2, "二跳页", "二跳正文。")],
    ["孤立.md", note(ORPHAN, "孤立页", "无人引用。")],
    ["分组/标签页.md", note(TAGGED, "标签页", "标签正文。", ["tags: [前端]"])],
  ];
}

test.describe("桌面冒烟：知识图谱（R015.1 G72–G83）", () => {
  test.beforeAll(() => {
    requireDesktopArtifacts();
  });

  test("@golden G72/G73/G76/G77/G79：Local Graph 出入边、点击打开、失效边修复、depth=2", async () => {
    const fixture = await createFixture(relationFiles());
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitDesktopWorkspaceReady(window);
      await waitLinkIndexReady(window);
      await waitDocumentReady(window, {
        pageName: "中心页",
        expectedText: "指向",
      });
      const local = window.locator(".local-graph");
      await expect(local.getByRole("heading", { name: "关系" })).toBeVisible();
      await expect(
        local.locator(".graph-node--outgoing", { hasText: "出站页" }),
      ).toBeVisible({
        timeout: LINK_TIMEOUT,
      });
      await expect(
        local.locator(".graph-node--incoming", { hasText: "来源页" }),
      ).toBeVisible();
      await expect(local.locator(".graph-edge--broken")).toHaveCount(1);

      await local.getByLabel("关系深度").selectOption("2");
      await expect(
        local.locator(".graph-node--hop2", { hasText: "二跳页" }),
      ).toBeVisible({
        timeout: LINK_TIMEOUT,
      });

      await local.getByRole("button", { name: /失效链接/ }).click();
      const picker = window.getByRole("dialog", { name: "选择页面" });
      await picker.getByRole("option", { name: /孤立页/ }).click();
      await expect(local.locator(".graph-edge--broken")).toHaveCount(0, {
        timeout: LINK_TIMEOUT,
      });

      await local.getByRole("button", { name: "出站页" }).click();
      await expect(
        window.getByRole("textbox", { name: "文档标题" }),
      ).toHaveValue("出站页", { timeout: LINK_TIMEOUT });
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G74：保存增删链接后 Local Graph 即时更新", async () => {
    const sourceId = "01JE2EGRAPH00000000011";
    const fixture = await createFixture([
      ["源.md", note(sourceId, "源页", "尚无链接。")],
      ["目标.md", note("01JE2EGRAPH00000000012", "目标页", "目标正文。")],
    ]);
    const sourceAbs = path.join(fixture.vaultDir, "源.md");
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitDesktopWorkspaceReady(window);
      await waitLinkIndexReady(window);
      await waitDocumentReady(window, {
        pageName: "源页",
        expectedText: "尚无链接。",
      });
      const local = window.locator(".local-graph");
      await expect(local.locator(".graph-node--outgoing")).toHaveCount(0);
      await insertInternalLink(window, "目标页");
      await expect(
        local.locator(".graph-node--outgoing", { hasText: "目标页" }),
      ).toBeVisible({
        timeout: LINK_TIMEOUT,
      });
      await replaceBodyAndWaitSaved(window, sourceAbs, "链接已移除。");
      await expect(
        local.locator(".graph-node--outgoing", { hasText: "目标页" }),
      ).toHaveCount(0, {
        timeout: LINK_TIMEOUT,
      });
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G74b：回收站删除 / 恢复后 Local Graph 即时刷新", async () => {
    const fixture = await createFixture([
      [
        "源.md",
        note("01JE2EGRAPH00000000071", "源页", "指向 [目标页](目标.md)。"),
      ],
      ["目标.md", note("01JE2EGRAPH00000000072", "目标页", "目标正文。")],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitDesktopWorkspaceReady(window);
      await waitLinkIndexReady(window);
      await waitDocumentReady(window, {
        pageName: "源页",
        expectedText: "指向",
      });
      const local = window.locator(".local-graph");
      const outgoing = local.locator(".graph-node--outgoing", {
        hasText: "目标页",
      });
      await expect(outgoing).toBeVisible({ timeout: LINK_TIMEOUT });

      // 删除目标页（UI 行内动作，与 G08 同口径）→ 节点 / 边消失。
      // clickTreeItem 打开目标页后指针留在行首，行内动作保持可见。
      const tree = window.getByRole("tree", { name: "页面树" });
      await clickTreeItem(window, /目标页/);
      await window.getByLabel("删除「目标页」").click();
      await expect(tree).not.toContainText("目标页", { timeout: UI_TIMEOUT });
      // IPC 层：链接索引已移除目标（deleted → links.remove → notifyGraph）。
      await expect
        .poll(
          async () => {
            const next = await graphOf(window).neighborhood(
              "01JE2EGRAPH00000000071",
              1,
            );
            return next?.nodes.some((n) => n.id === "01JE2EGRAPH00000000072")
              ? "still"
              : "gone";
          },
          { timeout: LINK_TIMEOUT },
        )
        .toBe("gone");
      // 回到来源页：Local Graph 出站节点消失。
      await clickTreeItem(window, /源页/);
      await waitDocumentReady(window, {
        pageName: "源页",
        expectedText: "指向",
      });
      await expect(outgoing).toHaveCount(0, { timeout: LINK_TIMEOUT });

      // 回收站恢复 → 节点与边恢复（回收站标题取原文件名「目标」，见
      // repositories.ts listByWorkspace 合并回收站条目约定）。
      await window.getByLabel("回收站", { exact: true }).click();
      const trashPanel = window.getByRole("dialog", { name: "回收站" });
      await expect(trashPanel).toContainText("目标");
      await trashPanel.getByText("目标", { exact: true }).hover();
      await trashPanel.getByLabel("恢复「目标」").click();
      await expect(trashPanel.getByText("回收站是空的。")).toBeVisible({
        timeout: UI_TIMEOUT,
      });
      await window.keyboard.press("Escape");
      await expect(outgoing).toBeVisible({ timeout: LINK_TIMEOUT });
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G75：rename 后节点身份不变", async () => {
    const targetId = "01JE2EGRAPH00000000021";
    const fixture = await createFixture([
      ["目标.md", note(targetId, "目标页", "目标正文。")],
      [
        "来源.md",
        note("01JE2EGRAPH00000000022", "来源页", "见 [目标页](目标.md)。"),
      ],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitDesktopWorkspaceReady(window);
      await waitLinkIndexReady(window);
      const before = await graphOf(window).neighborhood(targetId, 1);
      expect(before?.nodes.some((n) => n.id === targetId)).toBe(true);
      const plan = await window.evaluate(async (vaultId) => {
        const e1 = (
          window as unknown as {
            e1?: {
              fileOperation: {
                plan(
                  input: Record<string, unknown>,
                ): Promise<{ blockers: unknown[] }>;
                execute(input: {
                  vaultId: string;
                  plan: unknown;
                }): Promise<unknown>;
              };
            };
          }
        ).e1;
        if (!e1?.fileOperation) throw new Error("fileOperation 未暴露");
        const p = await e1.fileOperation.plan({
          kind: "rename-document-file",
          vaultId,
          fromRelativePath: "目标.md",
          newName: "新目标.md",
        });
        await e1.fileOperation.execute({ vaultId, plan: p });
        return p;
      }, VAULT_ID);
      expect(plan.blockers).toEqual([]);
      await expect
        .poll(
          async () => {
            const next = await graphOf(window).neighborhood(targetId, 1);
            return next?.nodes.some((n) => n.id === targetId) ? "ok" : "miss";
          },
          { timeout: LINK_TIMEOUT },
        )
        .toBe("ok");
      await waitDocumentReady(window, {
        pageName: "来源页",
        expectedText: "见",
      });
      await expect(
        window.locator(".local-graph .graph-node--outgoing", {
          hasText: "目标页",
        }),
      ).toBeVisible({ timeout: LINK_TIMEOUT });
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G75b：move 后图谱身份与链接改写", async () => {
    const targetId = "01JE2EGRAPH00000000061";
    const fixture = await createFixture([
      ["目标.md", note(targetId, "目标页", "目标正文。")],
      [
        "来源.md",
        note("01JE2EGRAPH00000000062", "来源页", "见 [目标页](目标.md)。"),
      ],
      ["分组/.gitkeep", ""],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitDesktopWorkspaceReady(window);
      await waitLinkIndexReady(window);
      const before = await graphOf(window).neighborhood(targetId, 1);
      expect(before?.nodes.some((n) => n.id === targetId)).toBe(true);
      // 把目标文档移入预建子目录（kind 与参数以 shared/ipc/contracts.ts 为准）。
      const plan = await window.evaluate(async (vaultId) => {
        const e1 = (
          window as unknown as {
            e1?: {
              fileOperation: {
                plan(
                  input: Record<string, unknown>,
                ): Promise<{ blockers: unknown[] }>;
                execute(input: {
                  vaultId: string;
                  plan: unknown;
                }): Promise<unknown>;
              };
            };
          }
        ).e1;
        if (!e1?.fileOperation) throw new Error("fileOperation 未暴露");
        const p = await e1.fileOperation.plan({
          kind: "move-document",
          vaultId,
          fromRelativePath: "目标.md",
          toRelativePath: "分组",
        });
        await e1.fileOperation.execute({ vaultId, plan: p });
        return p;
      }, VAULT_ID);
      expect(plan.blockers).toEqual([]);
      // (a) IPC 层：graph.neighborhood 按 stable id 仍能查到该节点。
      await expect
        .poll(
          async () => {
            const next = await graphOf(window).neighborhood(targetId, 1);
            return next?.nodes.some((n) => n.id === targetId) ? "ok" : "miss";
          },
          { timeout: LINK_TIMEOUT },
        )
        .toBe("ok");
      // 跨目录相对链接已改写。
      const source = await readFile(
        path.join(fixture.vaultDir, "来源.md"),
        "utf8",
      );
      expect(source).toContain("[目标页](分组/目标.md)");
      // (b) UI 层：打开来源页，Local Graph 出站边仍可见。
      await waitDocumentReady(window, {
        pageName: "来源页",
        expectedText: "见",
      });
      await expect(
        window.locator(".local-graph .graph-node--outgoing", {
          hasText: "目标页",
        }),
      ).toBeVisible({ timeout: LINK_TIMEOUT });
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G78：Workspace Graph 孤立文档筛选", async () => {
    const fixture = await createFixture(relationFiles());
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitDesktopWorkspaceReady(window);
      await waitLinkIndexReady(window);
      await window.getByLabel(/知识库「/).click();
      await window.getByRole("button", { name: "知识图谱" }).click();
      const dialog = window.getByRole("dialog", { name: "知识图谱" });
      await expect(
        dialog.getByRole("img", { name: "知识库关系图" }),
      ).toBeVisible({
        timeout: LINK_TIMEOUT,
      });
      await expect(
        dialog.getByRole("button", { name: "孤立页" }),
      ).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "中心页" }),
      ).toBeVisible();
      await dialog.getByLabel("仅孤立文档").check();
      await expect(dialog.getByRole("button", { name: "孤立页" })).toBeVisible({
        timeout: LINK_TIMEOUT,
      });
      await expect(dialog.getByRole("button", { name: "中心页" })).toHaveCount(
        0,
      );
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G78b：Workspace Graph 搜索 / 分组 / 标签筛选", async () => {
    const fixture = await createFixture(relationFiles());
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitDesktopWorkspaceReady(window);
      await waitLinkIndexReady(window);
      await window.getByLabel(/知识库「/).click();
      await window.getByRole("button", { name: "知识图谱" }).click();
      const dialog = window.getByRole("dialog", { name: "知识图谱" });
      await expect(
        dialog.getByRole("img", { name: "知识库关系图" }),
      ).toBeVisible({
        timeout: LINK_TIMEOUT,
      });
      await expect(
        dialog.getByRole("button", { name: "中心页" }),
      ).toBeVisible();

      // 搜索：命中节点保留，未命中节点消失。
      await dialog.getByLabel("搜索文档").fill("孤立");
      await expect(dialog.getByRole("button", { name: "孤立页" })).toBeVisible({
        timeout: LINK_TIMEOUT,
      });
      await expect(dialog.getByRole("button", { name: "中心页" })).toHaveCount(
        0,
      );
      await dialog.getByLabel("搜索文档").fill("");
      await expect(dialog.getByRole("button", { name: "中心页" })).toBeVisible({
        timeout: LINK_TIMEOUT,
      });

      // 分组筛选：仅「分组」下的标签页。
      await dialog.getByLabel("按分组筛选").selectOption("分组");
      await expect(dialog.getByRole("button", { name: "标签页" })).toBeVisible({
        timeout: LINK_TIMEOUT,
      });
      await expect(dialog.getByRole("button", { name: "中心页" })).toHaveCount(
        0,
      );
      await dialog.getByLabel("按分组筛选").selectOption("");
      await expect(dialog.getByRole("button", { name: "中心页" })).toBeVisible({
        timeout: LINK_TIMEOUT,
      });

      // 标签筛选：仅带「前端」标签的标签页。
      await dialog.getByLabel("按标签筛选").selectOption("前端");
      await expect(dialog.getByRole("button", { name: "标签页" })).toBeVisible({
        timeout: LINK_TIMEOUT,
      });
      await expect(dialog.getByRole("button", { name: "孤立页" })).toHaveCount(
        0,
      );
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G80：nodeLimit 截断（IPC 层 + UI 截断提示）", async () => {
    // 中心页出站 85 条：Local Graph UI nodeLimit=80 → 面板截断提示可见。
    const centerId = "01JE2EGRAPH00000000030";
    const files: Array<[string, string]> = [];
    const links: string[] = [];
    for (let i = 0; i < 85; i += 1) {
      const id = `01JE2EGRAPH0000001${String(i).padStart(3, "0")}`;
      links.push(`[链${i}](t${i}.md)`);
      files.push([`t${i}.md`, note(id, `链${i}`, `叶 ${i}。`)]);
    }
    files.push(["中心.md", note(centerId, "中心页", links.join(" "))]);
    const fixture = await createFixture(files);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitDesktopWorkspaceReady(window);
      await waitLinkIndexReady(window);
      // IPC 层截断（邻域 nodeLimit=2 / 工作区 nodeLimit=1）。
      const local = await graphOf(window).neighborhood(centerId, 1, 2);
      expect(local?.truncated).toBe(true);
      const ws = await graphOf(window).workspace({}, 1);
      expect(ws?.truncated).toBe(true);
      // UI 层：打开中心页，Local Graph（nodeLimit=80）截断提示可见。
      await waitDocumentReady(window, {
        pageName: "中心页",
        expectedText: "链0",
      });
      const hint = window.locator(".local-graph__hint");
      await expect(hint).toBeVisible({ timeout: LINK_TIMEOUT });
      await expect(hint).toHaveText("关系较多，已截断显示。");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G81：外部编辑 Markdown → Local Graph 刷新", async () => {
    const targetId = "01JE2EGRAPH00000000041";
    const fixture = await createFixture([
      ["目标.md", note(targetId, "目标页", "目标正文。")],
      ["外部源.md", note("01JE2EGRAPH00000000042", "外部源", "尚无链接。")],
    ]);
    const sourceAbs = path.join(fixture.vaultDir, "外部源.md");
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitDesktopWorkspaceReady(window);
      await waitLinkIndexReady(window);
      await waitDocumentReady(window, {
        pageName: "目标页",
        expectedText: "目标正文。",
      });
      await window.waitForTimeout(WATCHER_READY_MS);
      await appendFile(sourceAbs, "\n参考 [目标页](目标.md)。\n", "utf8");
      await expect(
        window.locator(".local-graph .graph-node--incoming", {
          hasText: "外部源",
        }),
      ).toBeVisible({ timeout: LINK_TIMEOUT });
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G82：版本恢复后图谱刷新", async () => {
    const id = "01JE2EGRAPH00000000051";
    const fixture = await createFixture([
      ["版本.md", note(id, "版本页", "指向 [目标页](目标.md)。")],
      ["目标.md", note("01JE2EGRAPH00000000052", "目标页", "目标正文。")],
    ]);
    const abs = path.join(fixture.vaultDir, "版本.md");
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitDesktopWorkspaceReady(window);
      await waitLinkIndexReady(window);
      await waitDocumentReady(window, {
        pageName: "版本页",
        expectedText: "指向",
      });
      const panel = window.getByRole("dialog", { name: "版本历史" });
      await window.getByRole("button", { name: "版本历史" }).click();
      await expect(panel).toBeVisible({ timeout: UI_TIMEOUT });
      await panel.getByRole("button", { name: "创建版本" }).click();
      await expect(panel.locator(".version-panel__item")).toHaveCount(1, {
        timeout: UI_TIMEOUT,
      });
      await window.keyboard.press("Escape");
      await replaceBodyAndWaitSaved(window, abs, "链接已移除。");
      await expect(
        window.locator(".local-graph .graph-node--outgoing", {
          hasText: "目标页",
        }),
      ).toHaveCount(0, { timeout: LINK_TIMEOUT });
      await restoreViaPanel(window, "指向");
      await expect(
        window.locator(".local-graph .graph-node--outgoing", {
          hasText: "目标页",
        }),
      ).toBeVisible({ timeout: LINK_TIMEOUT });
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G83：邻域查询在小库上即时返回（10k 见 wall-clock 基准）", async () => {
    const fixture = await createFixture(relationFiles());
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitDesktopWorkspaceReady(window);
      await waitLinkIndexReady(window);
      const started = Date.now();
      const result = await graphOf(window).neighborhood(CENTER, 2);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect((result?.nodes.length ?? 0) >= 3).toBe(true);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });
});
