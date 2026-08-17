// R006 阶段 0/1：桌面端冒烟测试（Playwright _electron）。
// 以生产模式启动 Electron（不注入 E1_DEV_SERVER_URL，加载 dist/desktop.html），
// 因此需要先运行 npm run build:desktop 产出 dist/ 与 dist-electron/。
// 本 spec 不进默认 test:e2e 链路：默认脚本以 --grep-invert "桌面冒烟" 排除，
// 独立运行用 npm run test:e2e:desktop（--grep "桌面冒烟"）。
// R006 阶段 2（C2）：新增「打开本地 Vault 全链路」用例；两个用例均以
// E1_USER_DATA_DIR 指向临时目录，recent-vaults.json 互相隔离、不污染开发数据。
// R006-C2.1：vault.open 已删除（SEC-01），全链路用例改为直接预置
// .e1/vault.json 与 recent-vaults.json，经 vault.openRecent + vault.scan
// 验证（原生目录选择器无法被 Playwright 驱动，选择链路见单元/组件测试）。
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requireDesktopArtifacts } from "./desktopArtifacts";

/** 以隔离的临时 userData 启动应用（返回 app 与清理函数）。 */
async function launchIsolated() {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "e1-userdata-"));
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, E1_USER_DATA_DIR: userDataDir },
  });
  return {
    app,
    async cleanup() {
      await app.close();
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}

test.describe("桌面冒烟", () => {
  test.beforeAll(() => {
    requireDesktopArtifacts();
  });

  test("桌面冒烟：desktop 入口渲染应用 UI + IPC 桥存在", async () => {
    const { app, cleanup } = await launchIsolated();
    const window = await app.firstWindow();

    // R006 阶段 1 预加载契约：contextBridge 暴露的完整 E1DesktopAPI
    // （platform + vault/vaultState/note/asset 四组方法 + R007 阶段 3 的
    // events 事件组；Renderer 拿不到 ipcRenderer）。
    const bridge = await window.evaluate(() => {
      const e1 = (
        window as unknown as {
          e1?: {
            platform?: string;
            vault?: Record<string, unknown>;
            vaultState?: Record<string, unknown>;
            note?: Record<string, unknown>;
            asset?: Record<string, unknown>;
            events?: Record<string, unknown>;
          };
        }
      ).e1;
      return {
        platform: e1?.platform,
        vault: Object.keys(e1?.vault ?? {}).sort(),
        vaultState: Object.keys(e1?.vaultState ?? {}).sort(),
        note: Object.keys(e1?.note ?? {}).sort(),
        asset: Object.keys(e1?.asset ?? {}).sort(),
        events: Object.keys(e1?.events ?? {}).sort(),
      };
    });
    expect(bridge).toEqual({
      platform: "desktop",
      // R006-C2.1：vault 组 open 删除，替换为 openSelection / openRecent。
      vault: [
        "listRecent",
        "openRecent",
        "openSelection",
        "scan",
        "selectDirectory",
      ],
      // R007 阶段 2：设备级交互状态组。
      vaultState: ["get", "patch"],
      // R007 阶段 1：patchMetadata（Frontmatter title/tags 局部写入）。
      note: ["create", "patchMetadata", "read", "save"],
      asset: ["import", "pick", "read", "resolveUrl"],
      // R007 阶段 3：Main→Renderer 单向事件组（Watcher 事实订阅）。
      events: ["subscribeVaultChanges"],
    });

    // R006 阶段 2 起 desktop.html 经 IPC-backed 容器渲染；隔离 userData 下
    // 无最近 Vault，进入开始首页（标题与知识库无关，空库也渲染）。
    await expect(window.getByRole("heading", { name: "开始" })).toBeVisible();
    // C2 能力门控入口：localDirectory=true → 「打开本地知识库」。
    await expect(window.getByLabel("打开本地知识库")).toBeVisible();

    await window.screenshot({ path: "test-results/desktop-smoke.png" });
    await cleanup();
  });

  test("桌面冒烟 @golden：打开本地 Vault 全链路（openRecent+scan+重开自动进入，US-01/06）", async () => {
    // 临时 Vault：52 个 Markdown + 5 个嵌套中文目录（其中一篇带 Frontmatter）。
    const vaultDir = await mkdtemp(path.join(os.tmpdir(), "e1-vault-"));
    const vaultName = path.basename(vaultDir);
    const files: Array<[string, string]> = [];
    files.push(
      ["根笔记一.md", "# 根笔记一\n"],
      ["根笔记二.md", "# 根笔记二\n"],
    );
    for (let i = 1; i <= 5; i += 1)
      files.push([`学习/学习笔记${i}.md`, `# 学习笔记${i}\n`]);
    for (let i = 1; i <= 19; i += 1)
      files.push([`学习/前端/前端笔记${i}.md`, `# 前端笔记${i}\n`]);
    files.push([
      "学习/前端/React 进阶.md",
      [
        "---",
        "id: 01JTESTSMOKE000000000001",
        "title: React 进阶",
        "tags: [前端, 框架]",
        "---",
        "",
        "# React 进阶",
        "",
      ].join("\n"),
    ]);
    for (let i = 1; i <= 5; i += 1)
      files.push([`工作/工作笔记${i}.md`, `# 工作笔记${i}\n`]);
    for (let i = 1; i <= 15; i += 1)
      files.push([`工作/会议/会议纪要${i}.md`, `# 会议纪要${i}\n`]);
    for (let i = 1; i <= 5; i += 1)
      files.push([`生活/生活笔记${i}.md`, `# 生活笔记${i}\n`]);
    for (const [rel, content] of files) {
      const abs = path.join(vaultDir, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
    }

    // R006-C2.1：原生目录选择器无法被 Playwright 驱动，直接预置
    // .e1/vault.json（模拟已初始化 Vault）与 recent-vaults.json（模拟已登记），
    // 全链路验证 vault.openRecent + vault.scan + 重开自动进入。
    const vaultId = "v-smoke-001";
    await mkdir(path.join(vaultDir, ".e1"));
    await writeFile(
      path.join(vaultDir, ".e1", "vault.json"),
      JSON.stringify({
        format: "e1-vault",
        formatVersion: 1,
        vaultId,
        name: vaultName,
        createdAt: "2026-08-09T00:00:00.000Z",
        assetsDirectory: "assets",
        identityMode: "frontmatter",
      }),
    );

    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "e1-userdata-"));
    await writeFile(
      path.join(userDataDir, "recent-vaults.json"),
      JSON.stringify([
        {
          vaultId,
          absolutePath: vaultDir,
          displayName: vaultName,
          lastOpenedAt: "2026-08-09T00:00:00.000Z",
        },
      ]),
    );
    const launch = () =>
      electron.launch({
        args: ["."],
        env: { ...process.env, E1_USER_DATA_DIR: userDataDir },
      });

    // —— 第一次启动：经 window.e1 直接打通 openRecent → scan ——
    const app1 = await launch();
    const window1 = await app1.firstWindow();
    const opened = await window1.evaluate(async (id) => {
      const e1 = (
        window as unknown as {
          e1: {
            vault: {
              openRecent(input: { vaultId: string }): Promise<{
                vaultId: string;
                name: string;
                initialized: boolean;
                transient?: boolean;
              }>;
              scan(vaultId: string): Promise<{
                vault: { vaultId: string | null; name: string };
                entries: Array<{
                  noteId: string | null;
                  relativePath: string;
                  kind: "group" | "document";
                  title: string;
                  parentPath: string | null;
                  tags: string[];
                }>;
              }>;
            };
          };
        }
      ).e1;
      const vault = await e1.vault.openRecent({ vaultId: id });
      const scan = await e1.vault.scan(vault.vaultId);
      return { vault, scan };
    }, vaultId);

    expect(opened.vault.initialized).toBe(false);
    expect(opened.vault.transient).toBeUndefined();
    expect(opened.vault.name).toBe(vaultName);
    expect(opened.scan.vault.vaultId).toBe(opened.vault.vaultId);
    // 52 篇文档 + 5 个目录分组（学习/学习·前端/工作/工作·会议/生活）。
    expect(opened.scan.entries).toHaveLength(57);
    expect(opened.scan.entries.filter((e) => e.kind === "group")).toHaveLength(
      5,
    );
    // 树形状抽查：Frontmatter 解析（id/title/tags）+ 父子链接。
    const react = opened.scan.entries.find(
      (e) => e.relativePath === "学习/前端/React 进阶.md",
    );
    expect(react).toMatchObject({
      noteId: "01JTESTSMOKE000000000001",
      kind: "document",
      title: "React 进阶",
      parentPath: "学习/前端",
      tags: ["前端", "框架"],
    });
    await app1.close();

    // —— 第二次启动（同一 userData）：自动列出最近 Vault 并进入（US-06）——
    const app2 = await launch();
    const window2 = await app2.firstWindow();
    // 侧栏出现该知识库（listRecent 映射），无需重新选目录。
    await expect(window2.getByLabel(`知识库「${vaultName}」`)).toBeVisible();
    // 页面树真实渲染：文件夹=分组、md=文档（Frontmatter 标题）。
    await expect(
      window2.getByRole("treeitem", { name: /React 进阶/ }),
    ).toBeVisible();
    await expect(
      window2.getByRole("treeitem", { name: /会议纪要15/ }),
    ).toBeVisible();
    await window2.screenshot({ path: "test-results/desktop-vault-smoke.png" });
    await app2.close();

    await rm(vaultDir, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  });
});
