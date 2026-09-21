// R015.1：Packaged App 知识图谱冒烟 P31–P34。
// 无安装包产物时 requirePackagedArtifact() 本地 skip、CI 抛错。
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { requirePackagedArtifact } from "../desktopArtifacts";
import { waitDesktopWorkspaceReady, waitDocumentReady } from "../desktopReady";
import {
  createPackageVaultFixture,
  launchPackaged,
  note,
} from "./packageFixture";

const VAULT_ID = "v-e2e-pkg-graph";
const LINK_TIMEOUT = 15_000;
const WATCHER_READY_MS = 800;

async function waitLinkIndexReady(window: Page) {
  await expect
    .poll(
      async () =>
        window.evaluate(async (vaultId) => {
          const e1 = (
            window as unknown as {
              e1?: {
                links?: {
                  status(input: {
                    vaultId: string;
                  }): Promise<{ state: string }>;
                };
              };
            }
          ).e1;
          return (await e1?.links?.status({ vaultId }))?.state ?? null;
        }, VAULT_ID),
      { timeout: LINK_TIMEOUT },
    )
    .toBe("ready");
}

/** 轮询直到 graph.neighborhood 按 stable id 能查到该节点。 */
async function expectGraphNodePresent(window: Page, noteKey: string) {
  await expect
    .poll(
      async () =>
        window.evaluate(
          async ({ vaultId, key }) => {
            const e1 = (
              window as unknown as {
                e1?: {
                  graph?: {
                    neighborhood(input: {
                      vaultId: string;
                      noteKey: string;
                      depth: 1;
                      nodeLimit: number;
                      edgeLimit: number;
                      includeBroken: boolean;
                    }): Promise<{ nodes: Array<{ id: string }> }>;
                  };
                };
              }
            ).e1;
            const result = await e1?.graph?.neighborhood({
              vaultId,
              noteKey: key,
              depth: 1,
              nodeLimit: 80,
              edgeLimit: 160,
              includeBroken: true,
            });
            return result?.nodes.some((n) => n.id === key) ?? false;
          },
          { vaultId: VAULT_ID, key: noteKey },
        ),
      { timeout: LINK_TIMEOUT },
    )
    .toBe(true);
}

test.describe("安装包冒烟：知识图谱（P31–P34）", () => {
  test.beforeAll(() => {
    requirePackagedArtifact();
  });

  test("P31：Local Graph 展示出入边，点击节点打开目标", async () => {
    const fixture = await createPackageVaultFixture(
      [
        [
          "中心.md",
          note("01JE2EPKGGRAPH000000001", "中心页", "指向 [出站页](出站.md)。"),
        ],
        ["出站.md", note("01JE2EPKGGRAPH000000002", "出站页", "出站正文。")],
        [
          "来源.md",
          note("01JE2EPKGGRAPH000000003", "来源页", "回指 [中心页](中心.md)。"),
        ],
      ],
      VAULT_ID,
    );
    const app = await launchPackaged(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitDesktopWorkspaceReady(window);
      await waitLinkIndexReady(window);
      await waitDocumentReady(window, {
        pageName: "中心页",
        expectedText: "指向",
      });
      const local = window.locator(".local-graph");
      await expect(
        local.locator(".graph-node--outgoing", { hasText: "出站页" }),
      ).toBeVisible({
        timeout: LINK_TIMEOUT,
      });
      await expect(
        local.locator(".graph-node--incoming", { hasText: "来源页" }),
      ).toBeVisible();
      await local.getByRole("button", { name: "出站页" }).click();
      await expect(
        window.getByRole("textbox", { name: "文档标题" }),
      ).toHaveValue("出站页", { timeout: LINK_TIMEOUT });
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("P32：Workspace Graph 孤立文档筛选", async () => {
    const fixture = await createPackageVaultFixture(
      [
        [
          "中心.md",
          note("01JE2EPKGGRAPH000000011", "中心页", "指向 [出站页](出站.md)。"),
        ],
        ["出站.md", note("01JE2EPKGGRAPH000000012", "出站页", "出站正文。")],
        ["孤立.md", note("01JE2EPKGGRAPH000000013", "孤立页", "无人引用。")],
      ],
      VAULT_ID,
    );
    const app = await launchPackaged(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitDesktopWorkspaceReady(window);
      await waitLinkIndexReady(window);
      await window.getByLabel(/知识库「/).click();
      await window.getByRole("button", { name: "知识图谱" }).click();
      const dialog = window.getByRole("dialog", { name: "知识图谱" });
      await expect(dialog.getByRole("button", { name: "孤立页" })).toBeVisible({
        timeout: LINK_TIMEOUT,
      });
      await dialog.getByLabel("仅孤立文档").check();
      await expect(
        dialog.getByRole("button", { name: "孤立页" }),
      ).toBeVisible();
      await expect(dialog.getByRole("button", { name: "中心页" })).toHaveCount(
        0,
      );
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("P33：外部编辑 Markdown → Local Graph 刷新", async () => {
    const targetId = "01JE2EPKGGRAPH000000021";
    const fixture = await createPackageVaultFixture(
      [
        ["目标.md", note(targetId, "目标页", "目标正文。")],
        ["外部源.md", note("01JE2EPKGGRAPH000000022", "外部源", "尚无链接。")],
      ],
      VAULT_ID,
    );
    const sourceAbs = path.join(fixture.vaultDir, "外部源.md");
    const app = await launchPackaged(fixture.userDataDir);
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

  test("P34：Document rename/move 后图谱节点身份保持", async () => {
    const targetId = "01JE2EPKGGRAPH000000031";
    const fixture = await createPackageVaultFixture(
      [
        ["目标.md", note(targetId, "目标页", "目标正文。")],
        [
          "来源.md",
          note("01JE2EPKGGRAPH000000032", "来源页", "见 [目标页](目标.md)。"),
        ],
        ["分组/.gitkeep", ""],
      ],
      VAULT_ID,
    );
    const app = await launchPackaged(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitDesktopWorkspaceReady(window);
      await waitLinkIndexReady(window);
      await window.evaluate(async (vaultId) => {
        const e1 = (
          window as unknown as {
            e1?: {
              fileOperation: {
                plan(input: Record<string, unknown>): Promise<unknown>;
                execute(input: {
                  vaultId: string;
                  plan: unknown;
                }): Promise<unknown>;
              };
            };
          }
        ).e1;
        if (!e1?.fileOperation) throw new Error("fileOperation 未暴露");
        const plan = await e1.fileOperation.plan({
          kind: "rename-document-file",
          vaultId,
          fromRelativePath: "目标.md",
          newName: "新目标.md",
        });
        await e1.fileOperation.execute({ vaultId, plan });
      }, VAULT_ID);
      await expectGraphNodePresent(window, targetId);

      // move 段（同构）：移入预建子目录后 stable id 身份同样保持。
      await window.evaluate(async (vaultId) => {
        const e1 = (
          window as unknown as {
            e1?: {
              fileOperation: {
                plan(input: Record<string, unknown>): Promise<unknown>;
                execute(input: {
                  vaultId: string;
                  plan: unknown;
                }): Promise<unknown>;
              };
            };
          }
        ).e1;
        if (!e1?.fileOperation) throw new Error("fileOperation 未暴露");
        const plan = await e1.fileOperation.plan({
          kind: "move-document",
          vaultId,
          fromRelativePath: "新目标.md",
          toRelativePath: "分组",
        });
        await e1.fileOperation.execute({ vaultId, plan });
      }, VAULT_ID);
      await expectGraphNodePresent(window, targetId);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });
});
