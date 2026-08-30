// R009 Stage 3：Packaged App E2E —— P07 Secrets / P08 Reveal。
// describe 以「安装包冒烟」为前缀，独立运行用 npm run test:e2e:package。
//
// P07 口径同 desktop.secrets.spec.ts（G09/G11）：按 secret.status 实测模式
// 分流——安全后端断言重启保持 + 磁盘无明文；不安全后端不失败，改断言
// session-only 降级文案（不伪装为安全）。
//
// P08 真实 shell.showItemInFolder 仅 macOS 本机可跑；Linux headless CI 没有
// 文件管理器会挂起（R009 §3.3），故按 process.platform 跳过。Linux/Windows 的
// 手动验收口径：安装包打开 Vault → 顶栏「在文件管理器中显示」→ 系统文件
// 管理器弹出并选中目标文件。packaged 下的 UI→IPC→PathGuard 链路已由
// desktop.reveal.spec.ts（E1_REVEAL_STUB 记录型 stub）覆盖。
import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { requirePackagedArtifact } from "../desktopArtifacts";
import {
  createPackageVaultFixture,
  launchPackaged,
  note,
} from "./packageFixture";

const API_KEY = "sk-packaged-机密-0123456789";

type SecretMode = "secure-persistent" | "session-only" | "unavailable";

async function readSecretMode(
  window: import("@playwright/test").Page,
): Promise<SecretMode | null> {
  return window.evaluate(async () => {
    const e1 = (
      window as unknown as {
        e1?: { secret?: { status(): Promise<{ mode: SecretMode }> } };
      }
    ).e1;
    return (await e1?.secret?.status())?.mode ?? null;
  });
}

async function configureAiKey(window: import("@playwright/test").Page) {
  await window.getByLabel("设置").click();
  const dialog = window.getByRole("dialog", { name: "设置" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Endpoint").fill("https://ai.local/v1");
  await dialog.getByLabel("模型").fill("gpt-packaged");
  await dialog.getByLabel("API Key").fill(API_KEY);
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog.getByText("已保存。")).toBeVisible();
  await expect(window.getByText("AI 已配置")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
}

test.describe("安装包冒烟：Secrets 与 Reveal（P07/P08）", () => {
  test.beforeAll(() => {
    requirePackagedArtifact();
  });

  test("P07：设置 AI Key → 重启 → 安全后端保持 / 不安全后端降级提示", async () => {
    const fixture = await createPackageVaultFixture(
      [["笔记.md", note("01JE2EPKG0000000000401", "笔记", "正文。")]],
      "v-e2e-pkg-secrets",
    );
    const secretsFile = path.join(fixture.userDataDir, "secrets.json");
    // --password-store=basic：Linux CI 无密钥链时 safeStorage 可评估为
    // basic_text → session-only（同 desktop.secrets.spec.ts）；macOS 下无害。
    const launch = (userDataDir: string) =>
      launchPackaged(userDataDir, { args: ["--password-store=basic"] });

    // 首次启动：读后端模式并写入 AI Key。
    const mode = await (async (): Promise<SecretMode | null> => {
      const app1 = await launch(fixture.userDataDir);
      try {
        const window = await app1.firstWindow();
        const m = await readSecretMode(window);
        expect(m).not.toBeNull();
        await configureAiKey(window);
        if (m !== "secure-persistent") {
          // 不安全后端：断言降级文案而不是失败（§8.7，不伪装为安全）。
          await window.getByLabel("设置").click();
          await expect(window.getByText(/本次会话有效/)).toBeVisible();
          await window.keyboard.press("Escape");
        }
        return m;
      } finally {
        await app1.close();
      }
    })();

    // 磁盘断言：安全后端密文无明文；不安全后端绝不弱保护落盘。
    if (existsSync(secretsFile)) {
      const onDisk = await readFile(secretsFile, "utf8");
      expect(onDisk).not.toContain(API_KEY);
      expect(onDisk).not.toContain("sk-packaged");
    }

    const app2 = await launch(fixture.userDataDir);
    try {
      const window = await app2.firstWindow();
      await window.getByLabel("设置").click();
      const dialog = window.getByRole("dialog", { name: "设置" });
      await expect(dialog).toBeVisible();
      if (mode === "secure-persistent") {
        // safeStorage 持久化：重启后 Key 仍在。
        await expect(window.getByText("AI 已配置")).toBeVisible();
        await expect(dialog.getByLabel("API Key")).toHaveValue(API_KEY);
        await expect(dialog.getByText(/系统凭据存储/)).toBeVisible();
      } else {
        // session-only：重启后 Key 不存在且有降级提示。
        await expect(window.getByText("AI 未配置")).toBeVisible();
        await expect(dialog.getByLabel("API Key")).toHaveValue("");
        await expect(window.getByText(/本次会话有效/)).toBeVisible();
      }
    } finally {
      await app2.close();
      await fixture.cleanup();
    }
  });

  test("P08：真实 showItemInFolder（macOS 本机）→ IPC 成功无错误", async () => {
    // Linux headless CI 无文件管理器，真实 shell.showItemInFolder 会挂起
    //（R009 §3.3）；UI→IPC→PathGuard 链路已由 E1_REVEAL_STUB 套件覆盖。
    test.skip(
      process.platform !== "darwin",
      "真实 showItemInFolder 仅 macOS 本机可跑；Linux/Windows 走手动验收（口径见文件头注释）",
    );
    const fixture = await createPackageVaultFixture(
      [["笔记.md", note("01JE2EPKG0000000000402", "笔记", "正文。")]],
      "v-e2e-pkg-reveal",
    );
    // 注意：不注入 E1_REVEAL_STUB，走真实 Finder（会弹出窗口，本机可接受）。
    const app = await launchPackaged(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      await window.getByRole("treeitem", { name: /笔记/ }).click();
      await expect(window.locator(".editor__content")).toContainText("正文。", {
        timeout: 15_000,
      });
      const reveal = window.getByRole("button", {
        name: "在文件管理器中显示",
      });
      await expect(reveal).toBeVisible();
      await reveal.click();
      // 真实 IPC（schema → PathGuard → shell.showItemInFolder）成功：
      // 无错误条；再给 OS 调用留出到达时间后确认仍无错误。
      await expect(window.locator(".recovery-banner")).toHaveCount(0);
      await window.waitForTimeout(1500);
      await expect(window.locator(".recovery-banner")).toHaveCount(0);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });
});

// R009 Stage 6（Auto Update）：P09 只验证「设置页入口 + Main 侧 update 组
// 接线」（getState 返回 idle + 当前版本），不点击检查更新——真实触网链路与
// 下载/安装由手动验收覆盖（E1_UPDATE_FEED_URL + 本地静态服务器，见 R009 §10）。
test.describe("安装包冒烟：Auto Update（P09）", () => {
  test.beforeAll(() => {
    requirePackagedArtifact();
  });

  test("P09：设置页显示「版本与更新」区，update.getState 经 IPC 返回当前版本", async () => {
    const fixture = await createPackageVaultFixture(
      [["笔记.md", note("01JE2EPKG0000000000403", "笔记", "正文。")]],
      "v-e2e-pkg-update",
    );
    const app = await launchPackaged(fixture.userDataDir);
    try {
      const window = await app.firstWindow();
      // Main 侧 update 组接线（electron-updater 在 asar 内可解析）。
      const state = await window.evaluate(async () => {
        const e1 = (
          window as unknown as {
            e1?: {
              update?: {
                getState(): Promise<{
                  state: string;
                  currentVersion: string;
                }>;
              };
            };
          }
        ).e1;
        return (await e1?.update?.getState()) ?? null;
      });
      expect(state).not.toBeNull();
      // 启动后 5s 有一次自动检查（R009 Stage 6），断言不锁定具体状态，
      // 只验证状态机在线且版本号回传正确。
      expect(state?.currentVersion).toMatch(/^\d+\.\d+\.\d+$/);

      await window.getByLabel("设置").click();
      const dialog = window.getByRole("dialog", { name: "设置" });
      await expect(dialog.getByText("版本与更新")).toBeVisible();
      await expect(
        dialog.getByText(`当前版本：v${state?.currentVersion}`),
      ).toBeVisible();
      // 自动检查可能进行中（正在检查…）或已落定（检查更新/前往下载等）。
      await expect(
        dialog
          .getByRole("button", { name: /检查更新|正在检查|下载更新|前往下载/ })
          .first(),
      ).toBeVisible();
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });
});
