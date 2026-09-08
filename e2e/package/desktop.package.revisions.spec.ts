// R012 Stage 7（需求 §41）：Packaged App 版本历史冒烟 P17–P20。
// 全部经 release/ 下真实安装包运行（requirePackagedArtifact 门禁，CI 缺产物
// 失败、本地缺产物 skip）——覆盖 asar 内 node:fs 快照落盘、AtomicFileWriter
// 恢复写、PathGuard 边界与链接/搜索索引 reconcile 链路。
//
// 断言风格同 P13–P16：window.e1 直调 IPC + node fs 磁盘断言；P18 额外走
// 真实 UI（VersionPanel 创建版本/二次确认恢复）验证打包产物的面板链路。
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { requirePackagedArtifact } from "../desktopArtifacts";
import {
  createPackageVaultFixture,
  launchPackaged,
  note,
} from "./packageFixture";
import { clickTreeItem } from "../tree";

/* ------------------------------ IPC 弱类型桥 ------------------------------ */
// 形状以 shared/ipc/contracts.ts E1DesktopAPI 为准，此处只声明断言用到的
// 字段子集；API 缺失时桥返回 null，随后的 expect 会红而不是静默跳过。

interface RevisionSummaryDto {
  revisionId: string;
  reason: "interval" | "manual" | "before-restore";
  createdAt: string;
  bodyBytes: number;
  textPreview: string;
}

interface PackageBridge {
  revisions?: {
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
      body: string;
      lineEnding: string;
    } | null>;
    capture(input: {
      vaultId: string;
      relativePath: string;
      stableNoteId?: string | null;
      reason: "interval" | "manual" | "before-restore";
    }): Promise<RevisionSummaryDto | null>;
    prune(input: {
      vaultId: string;
      relativePath: string;
      stableNoteId?: string | null;
      keep?: number;
    }): Promise<{ pruned: number }>;
    relocate(input: {
      vaultId: string;
      stableNoteId?: string | null;
      fromRelativePath: string;
      toRelativePath: string;
      prefix?: boolean;
    }): Promise<{ relocated: number }>;
  };
  fileOperation?: {
    plan(input: Record<string, unknown>): Promise<unknown>;
    execute(input: { vaultId: string; plan: unknown }): Promise<unknown>;
  };
}

// 注意：window.e1 上的方法不可跨 evaluate 序列化返回（函数会变成
// undefined），所有桥调用必须整体放进一次 evaluate 内执行。

/** 等打包应用就绪：preload 桥 + 页面树出现（Vault 已打开）。 */
async function waitPackagedReady(window: Page) {
  await window.waitForLoadState("domcontentloaded");
  await expect
    .poll(
      async () =>
        window.evaluate(() =>
          Boolean((window as unknown as { e1?: PackageBridge }).e1?.revisions),
        ),
      { timeout: 20_000 },
    )
    .toBe(true);
  await expect(window.getByRole("tree").first()).toBeVisible({
    timeout: 20_000,
  });
}

function listRevisions(
  window: Page,
  vaultId: string,
  relativePath: string,
  stableNoteId: string,
) {
  return window.evaluate(
    async ({ vaultId: vid, rel, sid }) => {
      const e1 = (window as unknown as { e1?: PackageBridge }).e1;
      if (!e1?.revisions) return null;
      return (
        await e1.revisions.list({
          vaultId: vid,
          relativePath: rel,
          stableNoteId: sid,
        })
      ).summaries;
    },
    { vaultId, rel: relativePath, sid: stableNoteId },
  );
}

function captureRevision(
  window: Page,
  vaultId: string,
  input: {
    relativePath: string;
    stableNoteId: string;
    reason: "interval" | "manual";
  },
) {
  return window.evaluate(
    async ({ vaultId: vid, ...rest }) => {
      const e1 = (window as unknown as { e1?: PackageBridge }).e1;
      if (!e1?.revisions) throw new Error("revisions 未暴露");
      return e1.revisions.capture({ vaultId: vid, ...rest });
    },
    { vaultId, ...input },
  );
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    await access(abs);
    return true;
  } catch {
    return false;
  }
}

/** 唯一 series 目录名（断言恰好一个 series 后返回其名）。 */
async function singleSeriesDir(vaultDir: string): Promise<string> {
  const dirs = await readdir(path.join(vaultDir, ".e1", "revisions", "series"));
  expect(dirs).toHaveLength(1);
  return dirs[0];
}

/** series 下的 revision 目录名列表。 */
function revisionDirs(vaultDir: string, seriesId: string) {
  return readdir(
    path.join(vaultDir, ".e1", "revisions", "series", seriesId, "revisions"),
  );
}

test.describe("安装包冒烟：R012 版本历史（P17–P20）", () => {
  test.beforeAll(() => {
    requirePackagedArtifact();
  });

  test("P17：打包产物 capture 落盘 + 重启后保持", async () => {
    const vaultId = "v-e2e-pkg-rev-p17";
    const noteId = "01JEPKGREV000000000001";
    const fixture = await createPackageVaultFixture(
      [["持久.md", note(noteId, "持久页", "打包捕获正文。")]],
      vaultId,
    );
    try {
      const app1 = await launchPackaged(fixture.userDataDir);
      try {
        const window = await app1.firstWindow();
        await waitPackagedReady(window);
        const captured = await captureRevision(window, vaultId, {
          relativePath: "持久.md",
          stableNoteId: noteId,
          reason: "manual",
        });
        expect(captured).not.toBeNull();
        expect(captured?.reason).toBe("manual");
        // asar 内 node:fs 落盘结构：series.json + revisions/<id>/{manifest,body}。
        const seriesId = await singleSeriesDir(fixture.vaultDir);
        const dirs = await revisionDirs(fixture.vaultDir, seriesId);
        expect(dirs).toContain(captured!.revisionId);
        const body = await readFile(
          path.join(
            fixture.vaultDir,
            ".e1",
            "revisions",
            "series",
            seriesId,
            "revisions",
            captured!.revisionId,
            "body.md",
          ),
          "utf8",
        );
        expect(body).toContain("打包捕获正文。");
      } finally {
        await app1.close();
      }

      // 重启打包产物（同 userData + 同 Vault）：历史从磁盘快照读回。
      const app2 = await launchPackaged(fixture.userDataDir);
      try {
        const window = await app2.firstWindow();
        await waitPackagedReady(window);
        const summaries = await listRevisions(
          window,
          vaultId,
          "持久.md",
          noteId,
        );
        expect(summaries).toHaveLength(1);
        expect(summaries?.[0].reason).toBe("manual");
        expect(summaries?.[0].textPreview).toContain("打包捕获正文。");
        const full = await window.evaluate(
          async ({ vaultId: vid, revisionId }) => {
            const e1 = (window as unknown as { e1?: PackageBridge }).e1;
            return e1!.revisions!.get({
              vaultId: vid,
              relativePath: "持久.md",
              stableNoteId: "01JEPKGREV000000000001",
              revisionId,
            });
          },
          { vaultId, revisionId: summaries![0].revisionId },
        );
        expect(full?.body).toContain("打包捕获正文。");
      } finally {
        await app2.close();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test("P18：打包产物 UI 恢复 + before-restore 快照生成", async () => {
    // UI 流程（打开文档 → 面板创建版本 → 编辑 → 二次确认恢复），步骤多，
    // 放宽全局 30s 上限。
    test.setTimeout(60_000);
    const vaultId = "v-e2e-pkg-rev-p18";
    const noteId = "01JEPKGREV000000000011";
    const fixture = await createPackageVaultFixture(
      [["恢复.md", note(noteId, "恢复页", "打包第一版正文。")]],
      vaultId,
    );
    const abs = path.join(fixture.vaultDir, "恢复.md");
    try {
      const app = await launchPackaged(fixture.userDataDir);
      try {
        const window = await app.firstWindow();
        await waitPackagedReady(window);
        await clickTreeItem(window, "恢复页");
        const editor = window.locator(".editor__content .ProseMirror");
        await expect(editor).toContainText("打包第一版正文。", {
          timeout: 20_000,
        });

        // 面板创建手动版本（v1）。
        await window.getByRole("button", { name: "版本历史" }).click();
        const panel = window.getByRole("dialog", { name: "版本历史" });
        await panel.getByRole("button", { name: "创建版本" }).click();
        await expect(panel.locator(".version-panel__item")).toHaveCount(1, {
          timeout: 20_000,
        });
        await window.keyboard.press("Escape");
        await expect(panel).toHaveCount(0);

        // 编辑为 v2 并等自动保存落盘；再编辑出 v2'（节流 5min 内第二次
        // 保存不再产生 interval 快照）——若当前正文与最新快照同 body，
        // 恢复时的 before-restore 捕获会被 §19 去重吞掉，面板/磁盘上
        // 就不会出现「恢复前」条目。
        await editor.click();
        await window.keyboard.press("ControlOrMeta+A");
        await window.keyboard.type("打包第二版正文。");
        await expect(window.getByText(/已保存/)).toBeVisible({
          timeout: 20_000,
        });
        await expect
          .poll(async () => readFile(abs, "utf8"), { timeout: 20_000 })
          .toContain("打包第二版正文。");
        await editor.click();
        await window.keyboard.press("ControlOrMeta+A");
        await window.keyboard.type("打包第二版正文。追加未快照段。");
        await expect(window.getByText(/已保存/)).toBeVisible({
          timeout: 20_000,
        });
        await expect
          .poll(async () => readFile(abs, "utf8"), { timeout: 20_000 })
          .toContain("打包第二版正文。追加未快照段。");

        // 面板恢复 v1（二次确认）：AtomicFileWriter 落盘 + 编辑器重建。
        // 按摘要 + 原因（手动）双条件收窄，防 interval 快照摘要撞车。
        await window.getByRole("button", { name: "版本历史" }).click();
        const panel2 = window.getByRole("dialog", { name: "版本历史" });
        const targetItem = panel2
          .locator(".version-panel__item")
          .filter({ hasText: "打包第一版正文。" })
          .filter({ hasText: "手动" });
        await expect(targetItem).toHaveCount(1, { timeout: 20_000 });
        await targetItem.locator(".version-panel__summary").click();
        await targetItem.getByRole("button", { name: "恢复此版本" }).click();
        await targetItem.getByRole("button", { name: "确认恢复？" }).click();
        await expect(panel2).toHaveCount(0, { timeout: 20_000 });
        await expect(editor).toContainText("打包第一版正文。", {
          timeout: 20_000,
        });
        await expect
          .poll(async () => readFile(abs, "utf8"), { timeout: 20_000 })
          .toContain("打包第一版正文。");
        const disk = await readFile(abs, "utf8");
        expect(disk).not.toContain("打包第二版正文。");
        expect(disk).toContain(`id: ${noteId}`);
        expect(disk).toContain("title: 恢复页");

        // 协调器在恢复前把当前 v2' 存为 before-restore 快照（§23）。
        const summaries = await listRevisions(
          window,
          vaultId,
          "恢复.md",
          noteId,
        );
        const reasons = summaries!.map((s) => s.reason);
        expect(reasons).toContain("manual");
        expect(reasons).toContain("before-restore");
        const beforeRestore = summaries!.find(
          (s) => s.reason === "before-restore",
        )!;
        expect(beforeRestore.textPreview).toContain(
          "打包第二版正文。追加未快照段。",
        );
      } finally {
        await app.close();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test("P19：打包产物 rename 后 revision identity 保持", async () => {
    const vaultId = "v-e2e-pkg-rev-p19";
    const noteId = "01JEPKGREV000000000021";
    const fixture = await createPackageVaultFixture(
      [["旧名.md", note(noteId, "身份页", "身份历史正文。")]],
      vaultId,
    );
    try {
      const app = await launchPackaged(fixture.userDataDir);
      try {
        const window = await app.firstWindow();
        await waitPackagedReady(window);
        const captured = await captureRevision(window, vaultId, {
          relativePath: "旧名.md",
          stableNoteId: noteId,
          reason: "manual",
        });
        expect(captured).not.toBeNull();

        // 物理改名 + revision series 路径搬迁（与 Renderer
        // DesktopFileOperationService 成功后动作同语义）。
        const relocated = await window.evaluate(async (vid) => {
          const e1 = (window as unknown as { e1?: PackageBridge }).e1;
          const plan = await e1!.fileOperation!.plan({
            kind: "rename-document-file",
            vaultId: vid,
            fromRelativePath: "旧名.md",
            newName: "新名.md",
          });
          await e1!.fileOperation!.execute({ vaultId: vid, plan });
          return e1!.revisions!.relocate({
            vaultId: vid,
            stableNoteId: "01JEPKGREV000000000021",
            fromRelativePath: "旧名.md",
            toRelativePath: "新名.md",
          });
        }, vaultId);
        expect(relocated.relocated).toBe(1);
        expect(await fileExists(path.join(fixture.vaultDir, "新名.md"))).toBe(
          true,
        );

        // stable-id 定位：新路径下历史仍在；series 元数据指向新路径。
        const summaries = await listRevisions(
          window,
          vaultId,
          "新名.md",
          noteId,
        );
        expect(summaries).toHaveLength(1);
        expect(summaries?.[0].textPreview).toContain("身份历史正文。");
        const seriesId = await singleSeriesDir(fixture.vaultDir);
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
        expect(series.stableNoteId).toBe(noteId);
        expect(series.currentRelativePath).toBe("新名.md");

        // series 延续：改名后继续捕获进同一 series（快照数 1 → 2）。
        await writeFile(
          path.join(fixture.vaultDir, "新名.md"),
          note(noteId, "身份页", "改名后第二版正文。"),
          "utf8",
        );
        const second = await captureRevision(window, vaultId, {
          relativePath: "新名.md",
          stableNoteId: noteId,
          reason: "manual",
        });
        expect(second).not.toBeNull();
        expect(await revisionDirs(fixture.vaultDir, seriesId)).toHaveLength(2);
      } finally {
        await app.close();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test("P20：打包产物 .e1/revisions 原子落盘结构 + interval retention", async () => {
    const vaultId = "v-e2e-pkg-rev-p20";
    const noteId = "01JEPKGREV000000000031";
    const fixture = await createPackageVaultFixture(
      [["裁剪.md", note(noteId, "裁剪页", "裁剪第 0 版。")]],
      vaultId,
    );
    const abs = path.join(fixture.vaultDir, "裁剪.md");
    try {
      const app = await launchPackaged(fixture.userDataDir);
      try {
        const window = await app.firstWindow();
        await waitPackagedReady(window);
        // 4 个 interval 快照（逐次外部改盘 + capture）+ 1 个 manual。
        for (let i = 1; i <= 4; i += 1) {
          await writeFile(
            abs,
            note(noteId, "裁剪页", `裁剪第 ${i} 版。`),
            "utf8",
          );
          const captured = await captureRevision(window, vaultId, {
            relativePath: "裁剪.md",
            stableNoteId: noteId,
            reason: "interval",
          });
          expect(captured).not.toBeNull();
        }
        await writeFile(abs, note(noteId, "裁剪页", "裁剪手动版。"), "utf8");
        const manual = await captureRevision(window, vaultId, {
          relativePath: "裁剪.md",
          stableNoteId: noteId,
          reason: "manual",
        });
        expect(manual).not.toBeNull();

        // 原子 store（§18）：5 个 revision 目录，各自 manifest.json +
        // body.md 齐备，无 .tmp- 临时目录残留；manifest 的 bodySha256
        // 与 body.md 实际内容一致（sha256 hex）。
        const seriesId = await singleSeriesDir(fixture.vaultDir);
        const revisionRoot = path.join(
          fixture.vaultDir,
          ".e1",
          "revisions",
          "series",
          seriesId,
          "revisions",
        );
        const dirs = await readdir(revisionRoot);
        expect(dirs).toHaveLength(5);
        expect(dirs.some((name) => name.includes(".tmp-"))).toBe(false);
        for (const dir of dirs) {
          const manifest = JSON.parse(
            await readFile(
              path.join(revisionRoot, dir, "manifest.json"),
              "utf8",
            ),
          ) as { version: number; bodySha256: string; bodyBytes: number };
          const body = await readFile(path.join(revisionRoot, dir, "body.md"));
          expect(manifest.version).toBe(1);
          expect(manifest.bodySha256).toBe(
            createHash("sha256").update(body).digest("hex"),
          );
          expect(manifest.bodyBytes).toBe(body.byteLength);
        }

        // retention（§26）：prune keep=2 → 最旧 2 个 interval 物理删除，
        // manual 永不自动裁剪；磁盘目录数 5 → 3。
        const pruned = await window.evaluate(
          async ({ vaultId: vid }) => {
            const e1 = (window as unknown as { e1?: PackageBridge }).e1;
            return e1!.revisions!.prune({
              vaultId: vid,
              relativePath: "裁剪.md",
              stableNoteId: "01JEPKGREV000000000031",
              keep: 2,
            });
          },
          { vaultId },
        );
        expect(pruned.pruned).toBe(2);
        const remaining = await readdir(revisionRoot);
        expect(remaining).toHaveLength(3);
        const summaries = await listRevisions(
          window,
          vaultId,
          "裁剪.md",
          noteId,
        );
        expect(summaries).toHaveLength(3);
        const reasons = summaries!.map((s) => s.reason).sort();
        expect(reasons).toEqual(["interval", "interval", "manual"]);
        // 最新 interval 恒保留：最新 interval 快照（第 4 版）仍在。
        const intervalSummaries = summaries!.filter(
          (s) => s.reason === "interval",
        );
        expect(intervalSummaries[0].textPreview).toContain("裁剪第 4 版。");
      } finally {
        await app.close();
      }
    } finally {
      await fixture.cleanup();
    }
  });
});
