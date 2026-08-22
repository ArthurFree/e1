// R007 阶段 5（§5.1，G3）：Desktop 机密存储 E2E（Playwright _electron，生产模式）。
// describe 以「桌面冒烟」为前缀：默认 test:e2e 经 --grep-invert 排除，
// 独立运行用 npm run test:e2e:desktop。
//
// @golden G09：AI Key 经系统安全存储持久化——重启保持 + 磁盘无明文。
// Linux CI（xvfb）无系统密钥链，以 Chromium 开关 --password-store=basic
// 强制 safeStorage 可用（Electron 会把该开关转发给 Chromium）；不可用
// 降级路径（会话内存 + status=false）由单元测试覆盖。
import { test, expect, _electron as electron } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requireDesktopArtifacts } from "./desktopArtifacts";

const VAULT_ID = "v-e2e-secrets";
const API_KEY = "sk-golden-机密-0123456789";

interface SecretsFixture {
  vaultDir: string;
  userDataDir: string;
  cleanup(): Promise<void>;
}

async function createFixture(): Promise<SecretsFixture> {
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "e1-vault-secret-"));
  const vaultName = path.basename(vaultDir);
  await mkdir(path.join(vaultDir, ".e1"));
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
  await writeFile(
    path.join(vaultDir, "笔记.md"),
    [
      "---",
      "id: 01JE2ESECRET000000000001",
      "title: 笔记",
      "---",
      "",
      "正文。",
      "",
    ].join("\n"),
  );
  const userDataDir = await mkdtemp(
    path.join(os.tmpdir(), "e1-userdata-secret-"),
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
    async cleanup() {
      await rm(vaultDir, { recursive: true, force: true });
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}

function launch(userDataDir: string) {
  return electron.launch({
    // Linux CI 无密钥链：强制 basic password store 使 safeStorage 可用。
    args: [".", "--password-store=basic"],
    env: { ...process.env, E1_USER_DATA_DIR: userDataDir },
  });
}

async function configureAiKey(window: import("@playwright/test").Page) {
  await window.getByLabel("设置").click();
  const dialog = window.getByRole("dialog", { name: "设置" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Endpoint").fill("https://ai.local/v1");
  await dialog.getByLabel("模型").fill("gpt-golden");
  await dialog.getByLabel("API Key").fill(API_KEY);
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog.getByText("已保存。")).toBeVisible();
  await expect(window.getByText("AI 已配置")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
}

test.describe("桌面冒烟：机密存储（R007 阶段 5）", () => {
  test.beforeAll(() => {
    requireDesktopArtifacts();
  });

  test("@golden G09：AI Key 系统安全存储持久化——重启保持且磁盘无明文", async () => {
    const fixture = await createFixture();
    const secretsFile = path.join(fixture.userDataDir, "secrets.json");
    const app1 = await launch(fixture.userDataDir);
    try {
      const window = await app1.firstWindow();
      // 装配根探测 safeStorage 可用性（basic password store 下应为可用）。
      await expect
        .poll(async () =>
          window.evaluate(async () => {
            const e1 = (
              window as unknown as {
                e1?: { secret?: { status(): Promise<{ available: boolean }> } };
              }
            ).e1;
            return (await e1?.secret?.status())?.available ?? null;
          }),
        )
        .toBe(true);
      await configureAiKey(window);
    } finally {
      await app1.close();
    }

    // 落盘：userData/secrets.json 存在且无明文；Vault 目录不携带机密。
    expect(existsSync(secretsFile)).toBe(true);
    const onDisk = await readFile(secretsFile, "utf8");
    expect(onDisk).not.toContain(API_KEY);
    expect(onDisk).not.toContain("sk-golden");
    expect(existsSync(path.join(fixture.vaultDir, "secrets.json"))).toBe(false);

    // 重启：配置仍在（endpoint/model 走偏好、apiKey 走 SecretStore）。
    const app2 = await launch(fixture.userDataDir);
    try {
      const window = await app2.firstWindow();
      await window.getByLabel("设置").click();
      const dialog = window.getByRole("dialog", { name: "设置" });
      await expect(dialog).toBeVisible();
      await expect(window.getByText("AI 已配置")).toBeVisible();
      // 保存的 Key 读回掩码输入框（SettingsPanel 启动时经 SecretStore 载入）。
      await expect(dialog.getByLabel("API Key")).toHaveValue(API_KEY);
      await expect(dialog.getByLabel("Endpoint")).toHaveValue(
        "https://ai.local/v1",
      );
    } finally {
      await app2.close();
      await fixture.cleanup();
    }
  });
});
