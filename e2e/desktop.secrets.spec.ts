// R008 Stage 1（§8，G2）：Desktop 机密存储 E2E（Playwright _electron，生产模式）。
// describe 以「桌面冒烟」为前缀：默认 test:e2e 经 --grep-invert 排除，
// 独立运行用 npm run test:e2e:desktop。
//
// @golden G09（安全后端）：AI Key 系统安全存储持久化——重启保持 + 磁盘无明文。
// @golden G11（不安全后端）：session-only——重启后 Key 不存在 + UI 提示。
// 两条用例按 secret.status 实测模式分流：macOS/Windows 安全后端跑 G09
//（G11 skip），Linux CI（basic_text/无密钥链）跑 G11（G09 skip）。
import { test, expect, _electron as electron } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requireDesktopArtifacts } from "./desktopArtifacts";

const VAULT_ID = "v-e2e-secrets";
const API_KEY = "sk-golden-机密-0123456789";

type SecretMode = "secure-persistent" | "session-only" | "unavailable";

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
    // Linux CI 无密钥链：basic password store 使 safeStorage 可评估，
    // R008 §8.5 判定 basic_text 为不安全后端 → session-only（G11 路径）。
    args: [".", "--password-store=basic"],
    env: { ...process.env, E1_USER_DATA_DIR: userDataDir },
  });
}

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
  await dialog.getByLabel("模型").fill("gpt-golden");
  await dialog.getByLabel("API Key").fill(API_KEY);
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog.getByText("已保存。")).toBeVisible();
  await expect(window.getByText("AI 已配置")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
}

test.describe("桌面冒烟：机密存储（R008 Stage 1）", () => {
  test.beforeAll(() => {
    requireDesktopArtifacts();
  });

  test("@golden G09：安全后端——AI Key 重启保持且磁盘无明文", async () => {
    const fixture = await createFixture();
    const secretsFile = path.join(fixture.userDataDir, "secrets.json");
    const app1 = await launch(fixture.userDataDir);
    try {
      const window = await app1.firstWindow();
      const mode = await readSecretMode(window);
      test.skip(
        mode !== "secure-persistent",
        `当前后端为 ${mode}，G09 仅覆盖安全后端（见 G11）`,
      );
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
      await expect(dialog.getByLabel("API Key")).toHaveValue(API_KEY);
      await expect(dialog.getByLabel("Endpoint")).toHaveValue(
        "https://ai.local/v1",
      );
      // 安全后端文案（§8.7）。
      await expect(dialog.getByText(/系统凭据存储/)).toBeVisible();
    } finally {
      await app2.close();
      await fixture.cleanup();
    }
  });

  test("@golden G11：不安全后端——session-only，重启后 Key 不存在且有 UI 提示", async () => {
    const fixture = await createFixture();
    const secretsFile = path.join(fixture.userDataDir, "secrets.json");
    const app1 = await launch(fixture.userDataDir);
    try {
      const window = await app1.firstWindow();
      const mode = await readSecretMode(window);
      test.skip(
        mode === "secure-persistent",
        "当前后端安全，G11 仅覆盖不安全后端（见 G09）",
      );
      await configureAiKey(window);
      // session-only 提示（§8.7：不伪装为安全）。
      await window.getByLabel("设置").click();
      await expect(window.getByText(/本次会话有效/)).toBeVisible();
      await window.keyboard.press("Escape");
    } finally {
      await app1.close();
    }

    // 绝不弱保护落盘：secrets.json 不存在或不含该 Key。
    if (existsSync(secretsFile)) {
      expect(await readFile(secretsFile, "utf8")).not.toContain(API_KEY);
    }

    // 重启：会话内存已消失，配置不再可用。
    const app2 = await launch(fixture.userDataDir);
    try {
      const window = await app2.firstWindow();
      await window.getByLabel("设置").click();
      const dialog = window.getByRole("dialog", { name: "设置" });
      await expect(dialog).toBeVisible();
      await expect(window.getByText("AI 未配置")).toBeVisible();
      await expect(dialog.getByLabel("API Key")).toHaveValue("");
      await expect(window.getByText(/本次会话有效/)).toBeVisible();
    } finally {
      await app2.close();
      await fixture.cleanup();
    }
  });
});
