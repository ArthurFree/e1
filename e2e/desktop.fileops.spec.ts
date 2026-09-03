// R011 Stage 7：文件操作 Desktop Golden E2E（G31–G43）。
// describe 以「桌面冒烟」为前缀；@golden 标记进黄金路径。
// 索引/路径事实优先走 window.e1.fileOperation.* 与磁盘读断言。
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

const VAULT_ID = "v-e2e-fileops";

interface FileOpsFixture {
  vaultDir: string;
  userDataDir: string;
  vaultName: string;
  cleanup(): Promise<void>;
}

async function createFixture(
  files: Array<[string, string | Buffer]>,
): Promise<FileOpsFixture> {
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "e1-vault-fileops-"));
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
  const userDataDir = await mkdtemp(
    path.join(os.tmpdir(), "e1-userdata-fileops-"),
  );
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
    vaultName,
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

interface FileOpBridge {
  plan(input: Record<string, unknown>): Promise<{
    operationId: string;
    kind: string;
    blockers: Array<{ code: string; message: string }>;
    warnings: Array<{ code: string; message: string }>;
    pathMoves: Array<{
      fromRelativePath: string;
      toRelativePath: string;
      noteKey: string | null;
    }>;
    patches: Array<{
      sourceRelativePathBefore: string;
      rules: Array<{ oldHref: string; newHref: string }>;
    }>;
    summary: {
      rewrittenLinks: number;
      rewrittenDocuments: number;
      rewrittenAssets: number;
    };
    target: Record<string, unknown>;
  }>;
  execute(input: {
    vaultId: string;
    plan: unknown;
  }): Promise<{ rewrittenLinks: number; pathMoves: unknown[] }>;
  recoveryStatus(input: { vaultId: string }): Promise<{
    phase: string;
    pendingOperationIds: string[];
  }>;
  recover(input: { vaultId: string }): Promise<{ recovered: boolean }>;
}

function fileOpOf(window: Page) {
  return {
    plan: (input: Record<string, unknown>) =>
      window.evaluate(async (payload) => {
        const e1 = (
          window as unknown as { e1?: { fileOperation?: FileOpBridge } }
        ).e1;
        if (!e1?.fileOperation) throw new Error("fileOperation 未暴露");
        return e1.fileOperation.plan(payload);
      }, input),
    execute: (vaultId: string, plan: unknown) =>
      window.evaluate(
        async ({ vaultId: id, plan: p }) => {
          const e1 = (
            window as unknown as { e1?: { fileOperation?: FileOpBridge } }
          ).e1;
          if (!e1?.fileOperation) throw new Error("fileOperation 未暴露");
          return e1.fileOperation.execute({ vaultId: id, plan: p });
        },
        { vaultId, plan },
      ),
    /** 期望 execute 失败；返回错误文案（跨桥编码进 message）。 */
    executeFail: (vaultId: string, plan: unknown) =>
      window.evaluate(
        async ({ vaultId: id, plan: p }) => {
          const e1 = (
            window as unknown as { e1?: { fileOperation?: FileOpBridge } }
          ).e1;
          if (!e1?.fileOperation) throw new Error("fileOperation 未暴露");
          try {
            await e1.fileOperation.execute({ vaultId: id, plan: p });
            return { ok: true as const, message: "" };
          } catch (err) {
            return {
              ok: false as const,
              message: err instanceof Error ? err.message : String(err),
            };
          }
        },
        { vaultId, plan },
      ),
    recoveryStatus: () =>
      window.evaluate(async (vaultId) => {
        const e1 = (
          window as unknown as { e1?: { fileOperation?: FileOpBridge } }
        ).e1;
        return e1?.fileOperation?.recoveryStatus({ vaultId });
      }, VAULT_ID),
    renameWorkspace: (name: string) =>
      window.evaluate(
        async ({ vaultId, name: n }) => {
          const e1 = (
            window as unknown as {
              e1?: { vault?: { rename?: (i: unknown) => Promise<unknown> } };
            }
          ).e1;
          return e1?.vault?.rename?.({ vaultId, name: n });
        },
        { vaultId: VAULT_ID, name },
      ),
  };
}

async function waitAppReady(window: Page) {
  await window.waitForLoadState("domcontentloaded");
  await expect
    .poll(
      async () =>
        window.evaluate(() => {
          const e1 = (
            window as unknown as { e1?: { fileOperation?: unknown } }
          ).e1;
          return Boolean(e1?.fileOperation);
        }),
      { timeout: 15_000 },
    )
    .toBe(true);
  // 等页面树出现（Vault 已打开）。
  await expect(window.getByRole("tree").first()).toBeVisible({
    timeout: 15_000,
  });
  // 链接索引 ready 后 plan 才能发现 inbound 影响。
  await expect
    .poll(
      async () =>
        window.evaluate(async (vaultId) => {
          const e1 = (
            window as unknown as {
              e1?: { links?: { status: (i: unknown) => Promise<{ state: string }> } };
            }
          ).e1;
          return (await e1?.links?.status({ vaultId }))?.state ?? null;
        }, VAULT_ID),
      { timeout: 20_000 },
    )
    .toBe("ready");
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    await access(abs);
    return true;
  } catch {
    return false;
  }
}

test.describe("桌面冒烟：R011 文件操作（G31–G43）", () => {
  test.beforeAll(() => {
    requireDesktopArtifacts();
  });

  test("@golden G31：Document 文件名重命名 → inbound link 自动改写", async () => {
    const targetId = "01JE2EFILE000000000001";
    const sourceId = "01JE2EFILE000000000002";
    const fixture = await createFixture([
      ["目标.md", note(targetId, "目标页", "目标正文。")],
      [
        "来源.md",
        note(sourceId, "来源页", "见 [目标页](目标.md)。"),
      ],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      const bridge = fileOpOf(window);
      const plan = await bridge.plan({
        kind: "rename-document-file",
        vaultId: VAULT_ID,
        fromRelativePath: "目标.md",
        newName: "新目标.md",
      });
      expect(plan.blockers).toEqual([]);
      expect(plan.summary.rewrittenLinks).toBeGreaterThanOrEqual(1);
      await bridge.execute(VAULT_ID, plan);
      expect(await fileExists(path.join(fixture.vaultDir, "目标.md"))).toBe(
        false,
      );
      expect(await fileExists(path.join(fixture.vaultDir, "新目标.md"))).toBe(
        true,
      );
      const source = await readFile(
        path.join(fixture.vaultDir, "来源.md"),
        "utf8",
      );
      expect(source).toContain("[目标页](新目标.md)");
      expect(source).not.toContain("(目标.md)");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G32/G34：Document move → inbound+outgoing 有效；title/id 不变", async () => {
    const aId = "01JE2EFILE000000000011";
    const bId = "01JE2EFILE000000000012";
    const fixture = await createFixture([
      [
        "A.md",
        note(aId, "文档 A", "出站 [B](B.md)。\n"),
      ],
      ["B.md", note(bId, "文档 B", "回指 [A](A.md)。\n")],
      ["notes/.gitkeep", ""],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      const bridge = fileOpOf(window);
      const plan = await bridge.plan({
        kind: "move-document",
        vaultId: VAULT_ID,
        fromRelativePath: "A.md",
        toRelativePath: "notes",
      });
      expect(plan.blockers).toEqual([]);
      await bridge.execute(VAULT_ID, plan);
      const moved = await readFile(
        path.join(fixture.vaultDir, "notes", "A.md"),
        "utf8",
      );
      expect(moved).toContain(`id: ${aId}`);
      expect(moved).toContain("title: 文档 A");
      expect(moved).toMatch(/\[B\]\(\.\.\/B\.md\)/);
      const b = await readFile(path.join(fixture.vaultDir, "B.md"), "utf8");
      expect(b).toContain("[A](notes/A.md)");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G33：Document move → managed asset 相对路径保持可解析", async () => {
    const docId = "01JE2EFILE000000000021";
    const fixture = await createFixture([
      [
        "图文.md",
        note(docId, "图文", "![图](assets/demo.png)\n"),
      ],
      ["assets/demo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47])],
      ["deep/.gitkeep", ""],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      const bridge = fileOpOf(window);
      const plan = await bridge.plan({
        kind: "move-document",
        vaultId: VAULT_ID,
        fromRelativePath: "图文.md",
        toRelativePath: "deep",
      });
      await bridge.execute(VAULT_ID, plan);
      const md = await readFile(
        path.join(fixture.vaultDir, "deep", "图文.md"),
        "utf8",
      );
      expect(md).toMatch(/!\[图\]\(<\.\.\/assets\/demo\.png>\)|!\[图\]\(\.\.\/assets\/demo\.png\)/);
      expect(
        await fileExists(path.join(fixture.vaultDir, "assets", "demo.png")),
      ).toBe(true);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G35/G36/G37：Group rename/move → 内外链接有效；子树内部相对不变", async () => {
    const inId = "01JE2EFILE000000000031";
    const outId = "01JE2EFILE000000000032";
    const siblingId = "01JE2EFILE000000000033";
    const fixture = await createFixture([
      [
        "学习/内页.md",
        note(inId, "内页", "同组 [兄弟](兄弟.md)。\n外链 [外](../外页.md)。\n"),
      ],
      ["学习/兄弟.md", note(siblingId, "兄弟", "兄弟正文。\n")],
      [
        "外页.md",
        note(outId, "外页", "指 [内](学习/内页.md)。\n"),
      ],
      ["归档/.gitkeep", ""],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      const bridge = fileOpOf(window);

      // G35：分组改名
      const renamePlan = await bridge.plan({
        kind: "rename-group",
        vaultId: VAULT_ID,
        fromRelativePath: "学习",
        newName: "进阶",
      });
      expect(renamePlan.blockers).toEqual([]);
      await bridge.execute(VAULT_ID, renamePlan);
      const outerAfterRename = await readFile(
        path.join(fixture.vaultDir, "外页.md"),
        "utf8",
      );
      expect(outerAfterRename).toContain("[内](进阶/内页.md)");
      const innerAfterRename = await readFile(
        path.join(fixture.vaultDir, "进阶", "内页.md"),
        "utf8",
      );
      // G37：子树内部相对链接无需无意义改写
      expect(innerAfterRename).toContain("[兄弟](兄弟.md)");
      expect(innerAfterRename).toContain("[外](../外页.md)");

      // IPC 直调跳过 Renderer reconcile：显式 rebuild 后再 plan move。
      await window.evaluate(async (vaultId) => {
        const e1 = (
          window as unknown as {
            e1?: { links?: { rebuild: (i: unknown) => Promise<unknown> } };
          }
        ).e1;
        await e1?.links?.rebuild({ vaultId });
      }, VAULT_ID);
      await expect
        .poll(
          async () =>
            window.evaluate(async (vaultId) => {
              const e1 = (
                window as unknown as {
                  e1?: {
                    links?: {
                      status: (i: unknown) => Promise<{ state: string }>;
                    };
                  };
                }
              ).e1;
              return (await e1?.links?.status({ vaultId }))?.state ?? null;
            }, VAULT_ID),
          { timeout: 15_000 },
        )
        .toBe("ready");

      // G36：分组移动
      const movePlan = await bridge.plan({
        kind: "move-group",
        vaultId: VAULT_ID,
        fromRelativePath: "进阶",
        toRelativePath: "归档",
      });
      expect(movePlan.blockers).toEqual([]);
      await bridge.execute(VAULT_ID, movePlan);
      const outerAfterMove = await readFile(
        path.join(fixture.vaultDir, "外页.md"),
        "utf8",
      );
      expect(outerAfterMove).toContain("[内](归档/进阶/内页.md)");
      const innerAfterMove = await readFile(
        path.join(fixture.vaultDir, "归档", "进阶", "内页.md"),
        "utf8",
      );
      expect(innerAfterMove).toContain("[兄弟](兄弟.md)");
      expect(innerAfterMove).toMatch(/\[外\]\(\.\.\/\.\.\/外页\.md\)/);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G38：dirty / blocker plan → execute 被拒绝且文件未改", async () => {
    const targetId = "01JE2EFILE000000000041";
    const fixture = await createFixture([
      ["目标.md", note(targetId, "目标页", "目标正文。")],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      const bridge = fileOpOf(window);
      const plan = await bridge.plan({
        kind: "rename-document-file",
        vaultId: VAULT_ID,
        fromRelativePath: "目标.md",
        newName: "改名目标.md",
      });
      // Renderer dirty 注入由 DesktopFileOperationService 单测锁定；
      // 此处锁定引擎对 blocker 的拒绝语义（FILEOP-09 / FILEOP-12）。
      plan.blockers.push({
        code: "FILE_OPERATION_BLOCKED_DIRTY",
        message: "「目标.md」有未保存更改，请先保存或丢弃后再操作。",
      });
      const fail = await bridge.executeFail(VAULT_ID, plan);
      expect(fail.ok).toBe(false);
      expect(fail.message).toMatch(/未保存|DIRTY|BLOCKED/i);
      expect(await fileExists(path.join(fixture.vaultDir, "目标.md"))).toBe(
        true,
      );
      expect(await fileExists(path.join(fixture.vaultDir, "改名目标.md"))).toBe(
        false,
      );
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G39：外部编辑导致 stale plan → 不覆盖", async () => {
    const targetId = "01JE2EFILE000000000051";
    const sourceId = "01JE2EFILE000000000052";
    const fixture = await createFixture([
      ["目标.md", note(targetId, "目标页", "目标。")],
      ["来源.md", note(sourceId, "来源页", "见 [目标页](目标.md)。")],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      const bridge = fileOpOf(window);
      const plan = await bridge.plan({
        kind: "rename-document-file",
        vaultId: VAULT_ID,
        fromRelativePath: "目标.md",
        newName: "新目标.md",
      });
      // 外部改写来源文档，使 patch versionToken 失效。
      await writeFile(
        path.join(fixture.vaultDir, "来源.md"),
        note(sourceId, "来源页", "见 [目标页](目标.md)。\n外部追加。\n"),
        "utf8",
      );
      const fail = await bridge.executeFail(VAULT_ID, plan);
      expect(fail.ok).toBe(false);
      expect(fail.message).toMatch(/STALE|过期|版本|变更/i);
      expect(await fileExists(path.join(fixture.vaultDir, "目标.md"))).toBe(
        true,
      );
      expect(await fileExists(path.join(fixture.vaultDir, "新目标.md"))).toBe(
        false,
      );
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G40：collision → 无文件被覆盖", async () => {
    const fixture = await createFixture([
      ["甲.md", note("01JE2EFILE000000000061", "甲", "甲。")],
      ["乙.md", note("01JE2EFILE000000000062", "乙", "乙。")],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      const bridge = fileOpOf(window);
      const plan = await bridge.plan({
        kind: "rename-document-file",
        vaultId: VAULT_ID,
        fromRelativePath: "甲.md",
        newName: "乙.md",
      });
      const fail = await bridge.executeFail(VAULT_ID, plan);
      expect(fail.ok).toBe(false);
      expect(fail.message).toMatch(/存在|COLLISION|冲突/i);
      expect(await readFile(path.join(fixture.vaultDir, "乙.md"), "utf8")).toContain(
        "title: 乙",
      );
      expect(await fileExists(path.join(fixture.vaultDir, "甲.md"))).toBe(true);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G41：case-only rename（temp-hop）", async () => {
    const id = "01JE2EFILE000000000071";
    const fixture = await createFixture([
      ["Foo.md", note(id, "Foo", "正文。")],
    ]);
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      const bridge = fileOpOf(window);
      const plan = await bridge.plan({
        kind: "rename-document-file",
        vaultId: VAULT_ID,
        fromRelativePath: "Foo.md",
        newName: "foo.md",
      });
      await bridge.execute(VAULT_ID, plan);
      const names = await readdir(fixture.vaultDir);
      expect(names.filter((n) => n.toLowerCase() === "foo.md")).toHaveLength(1);
      const content = await readFile(
        path.join(fixture.vaultDir, names.find((n) => /foo\.md/i.test(n))!),
        "utf8",
      );
      expect(content).toContain(`id: ${id}`);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G42：Workspace logical rename → root path 不变", async () => {
    const fixture = await createFixture([
      ["欢迎.md", note("01JE2EFILE000000000081", "欢迎", "你好。")],
    ]);
    const rootBefore = fixture.vaultDir;
    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      const bridge = fileOpOf(window);
      await bridge.renameWorkspace("新逻辑名");
      const vaultJson = JSON.parse(
        await readFile(path.join(fixture.vaultDir, ".e1", "vault.json"), "utf8"),
      ) as { name: string; vaultId: string };
      expect(vaultJson.name).toBe("新逻辑名");
      expect(vaultJson.vaultId).toBe(VAULT_ID);
      expect(fixture.vaultDir).toBe(rootBefore);
      expect(await fileExists(path.join(fixture.vaultDir, "欢迎.md"))).toBe(
        true,
      );
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("@golden G43：中断 journal → 下次启动自动恢复", async () => {
    const id = "01JE2EFILE000000000091";
    const original = note(id, "原稿", "原始内容。");
    const fixture = await createFixture([["原稿.md", original]]);
    const opId = "op-crash-e2e-001";
    const journalDir = path.join(
      fixture.vaultDir,
      ".e1",
      "operations",
      opId,
    );
    await mkdir(path.join(journalDir, "backup"), { recursive: true });
    await writeFile(
      path.join(journalDir, "backup", "原稿.md"),
      original,
      "utf8",
    );
    await writeFile(
      path.join(journalDir, "manifest.json"),
      JSON.stringify({
        version: 1,
        operationId: opId,
        vaultId: VAULT_ID,
        kind: "rename-document-file",
        phase: "rewriting",
        fromRelativePath: "原稿.md",
        toRelativePath: "改写中.md",
        backups: [
          {
            originalRelativePath: "原稿.md",
            backupRelativePath: "backup/原稿.md",
            versionToken: "sha256:deadbeef",
          },
        ],
        createdAt: "2026-09-03T00:00:00.000Z",
      }),
      "utf8",
    );
    // 模拟半完成改写：磁盘内容被污染。
    await writeFile(
      path.join(fixture.vaultDir, "原稿.md"),
      note(id, "原稿", "半完成污染。"),
      "utf8",
    );

    const app = await launch(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await waitAppReady(window);
      await expect
        .poll(async () => readFile(path.join(fixture.vaultDir, "原稿.md"), "utf8"), {
          timeout: 10_000,
        })
        .toContain("原始内容。");
      const status = await fileOpOf(window).recoveryStatus();
      expect(status?.phase).toBe("clean");
      expect(
        await fileExists(path.join(fixture.vaultDir, ".e1", "operations", opId)),
      ).toBe(false);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });
});
