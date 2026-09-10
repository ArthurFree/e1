// R013 Stage 4/5：Packaged App 信任与自动更新 P21–P26。
// describe 以「安装包冒烟」为前缀，随 test:e2e:package 运行。
//
// P21–P23 调 scripts/verifyMac*（与 Release Distribution Correctness 同口径）。
// 本地 unsigned 产物 skip；正式 Release（E1_REQUIRE_SIGNED=1）必须通过。
// P25 后半 / P26 完整 vA→vB 需 E1_UPDATE_FEED_URL 演练环境，未设置则 skip。
import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  requirePackagedArtifact,
  requireSignedMode,
  requireSignedPackagedArtifact,
  resolvePackagedAppBundle,
} from "../desktopArtifacts";
import {
  createPackageVaultFixture,
  launchPackaged,
  note,
} from "./packageFixture";

const root = fileURLToPath(new URL("../..", import.meta.url));
const API_KEY = "sk-signed-机密-0123456789";

function runVerifyScript(scriptName: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "scripts", scriptName)],
    {
      encoding: "utf8",
      env: { ...process.env },
      cwd: root,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function skipIfUnsignedLocal(output: string): boolean {
  if (requireSignedMode()) return false;
  return /^\s*skip:/m.test(output);
}

test.describe("安装包冒烟：签名与分发信任（P21–P23）", () => {
  test.beforeAll(() => {
    requireSignedPackagedArtifact();
  });

  test("P21：Developer ID signing identity valid", () => {
    const result = runVerifyScript("verifyMacSigning.mjs");
    const output = `${result.stdout}\n${result.stderr}`;
    if (skipIfUnsignedLocal(output)) {
      test.skip(true, "本地 unsigned 产物，P21 仅在 signed Release 上强制");
    }
    expect(result.status, output).toBe(0);
    expect(result.stdout).toMatch(/signing valid/);
  });

  test("P22：Hardened Runtime + entitlement whitelist valid", () => {
    const result = runVerifyScript("verifyMacEntitlements.mjs");
    const output = `${result.stdout}\n${result.stderr}`;
    if (skipIfUnsignedLocal(output)) {
      test.skip(true, "本地 unsigned 产物，P22 仅在 signed Release 上强制");
    }
    expect(result.status, output).toBe(0);
    expect(result.stdout).toMatch(/entitlements valid/);
  });

  test("P23：notarization + stapling + Gatekeeper accepted", () => {
    const result = runVerifyScript("verifyMacDistribution.mjs");
    const output = `${result.stdout}\n${result.stderr}`;
    if (skipIfUnsignedLocal(output)) {
      test.skip(true, "本地 unsigned 产物，P23 仅在 signed Release 上强制");
    }
    expect(result.status, output).toBe(0);
    expect(result.stdout).toMatch(/distribution valid/);
  });
});

test.describe("安装包冒烟：signed safeStorage（P24）", () => {
  test.beforeAll(() => {
    requireSignedPackagedArtifact();
  });

  test("P24：signed app 写入 secret → 重启后仍可读", async () => {
    const appBundle = resolvePackagedAppBundle();
    if (appBundle && existsSync(appBundle) && process.platform === "darwin") {
      const verify = runVerifyScript("verifyMacSigning.mjs");
      const output = `${verify.stdout}\n${verify.stderr}`;
      if (requireSignedMode()) {
        expect(verify.status, output).toBe(0);
      } else if (skipIfUnsignedLocal(output)) {
        test.skip(true, "本地 unsigned 产物，P24 仅在 signed app 上强制");
      }
    }

    const fixture = await createPackageVaultFixture(
      [["笔记.md", note("01JE2EPKG0000000002101", "笔记", "正文。")]],
      "v-e2e-pkg-signed-secret",
    );
    const secretsFile = path.join(fixture.userDataDir, "secrets.json");

    const app1 = await launchPackaged(fixture.userDataDir);
    try {
      const window = await app1.firstWindow();
      const mode = await window.evaluate(async () => {
        const e1 = (
          window as unknown as {
            e1?: { secret?: { status(): Promise<{ mode: string }> } };
          }
        ).e1;
        return (await e1?.secret?.status())?.mode ?? null;
      });
      expect(mode).toBe("secure-persistent");
      await window.getByLabel("设置").click();
      const dialog = window.getByRole("dialog", { name: "设置" });
      await dialog.getByLabel("Endpoint").fill("https://ai.local/v1");
      await dialog.getByLabel("模型").fill("gpt-signed");
      await dialog.getByLabel("API Key").fill(API_KEY);
      await dialog.getByRole("button", { name: "保存" }).click();
      await expect(dialog.getByText("已保存。")).toBeVisible();
    } finally {
      await app1.close();
    }

    if (existsSync(secretsFile)) {
      const onDisk = await readFile(secretsFile, "utf8");
      expect(onDisk).not.toContain(API_KEY);
    }

    const app2 = await launchPackaged(fixture.userDataDir);
    try {
      const window = await app2.firstWindow();
      await window.getByLabel("设置").click();
      const dialog = window.getByRole("dialog", { name: "设置" });
      await expect(window.getByText("AI 已配置")).toBeVisible();
      await expect(dialog.getByLabel("API Key")).toHaveValue(API_KEY);
    } finally {
      await app2.close();
      await fixture.cleanup();
    }
  });
});

test.describe("安装包冒烟：signed auto update（P25/P26）", () => {
  test.beforeAll(() => {
    requirePackagedArtifact();
  });

  test("P25：signed app canAutoInstall=true（完整 vA→vB 需 E1_UPDATE_FEED_URL）", async () => {
    requireSignedPackagedArtifact();
    const verify = runVerifyScript("verifyMacSigning.mjs");
    const output = `${verify.stdout}\n${verify.stderr}`;
    if (requireSignedMode()) {
      expect(verify.status, output).toBe(0);
    } else if (skipIfUnsignedLocal(output)) {
      test.skip(true, "本地 unsigned 产物，P25 仅在 signed app 上强制");
    }

    const fixture = await createPackageVaultFixture(
      [["笔记.md", note("01JE2EPKG0000000002102", "笔记", "封面。")]],
      "v-e2e-pkg-signed-update",
    );
    const feedUrl = process.env.E1_UPDATE_FEED_URL;
    const app = await launchPackaged(fixture.userDataDir, {
      env: feedUrl ? { E1_UPDATE_FEED_URL: feedUrl } : {},
    });
    try {
      const window = await app.firstWindow();
      const state = await window.evaluate(async () => {
        const e1 = (
          window as unknown as {
            e1?: {
              update?: {
                getState(): Promise<{
                  canAutoInstall: boolean;
                  currentVersion: string;
                  state: string;
                }>;
                check(): Promise<{
                  state: string;
                  latestVersion?: string;
                }>;
                download(): Promise<{ state: string }>;
              };
            };
          }
        ).e1;
        const current = (await e1?.update?.getState()) ?? null;
        return { current, check: e1?.update?.check, download: e1?.update };
      });
      expect(state.current?.canAutoInstall).toBe(true);

      if (!feedUrl) {
        test.info().annotations.push({
          type: "note",
          description:
            "未设置 E1_UPDATE_FEED_URL：只断言 canAutoInstall。完整 vA→vB 见 Stage 7 演练。",
        });
        return;
      }

      const checked = await window.evaluate(async () => {
        const e1 = (
          window as unknown as {
            e1?: {
              update?: {
                check(): Promise<{
                  state: string;
                  latestVersion?: string;
                  errorMessage?: string;
                }>;
              };
            };
          }
        ).e1;
        return (await e1?.update?.check()) ?? null;
      });
      expect(checked?.state).toBe("available");
      const downloaded = await window.evaluate(async () => {
        const e1 = (
          window as unknown as {
            e1?: {
              update?: {
                download(): Promise<{ state: string }>;
              };
            };
          }
        ).e1;
        return (await e1?.update?.download()) ?? null;
      });
      expect(downloaded?.state).toBe("downloaded");
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });

  test("P26：signed app 重启后 Vault / secret 保持（非 vA→vB）", async () => {
    requireSignedPackagedArtifact();
    const verify = runVerifyScript("verifyMacSigning.mjs");
    const output = `${verify.stdout}\n${verify.stderr}`;
    if (requireSignedMode()) {
      expect(verify.status, output).toBe(0);
    } else if (skipIfUnsignedLocal(output)) {
      test.skip(true, "本地 unsigned 产物，P26 仅在 signed app 上强制");
    }

    const fixture = await createPackageVaultFixture(
      [["笔记.md", note("01JE2EPKG0000000002103", "笔记", "升级前正文。")]],
      "v-e2e-pkg-signed-integrity",
    );

    const app1 = await launchPackaged(fixture.userDataDir);
    try {
      const window = await app1.firstWindow();
      await window.getByRole("treeitem", { name: /笔记/ }).click();
      await expect(
        window.locator(".editor__content .ProseMirror"),
      ).toContainText("升级前正文。", { timeout: 15_000 });
      await window.getByLabel("设置").click();
      const dialog = window.getByRole("dialog", { name: "设置" });
      await dialog.getByLabel("Endpoint").fill("https://ai.local/v1");
      await dialog.getByLabel("模型").fill("gpt-keep");
      await dialog.getByLabel("API Key").fill(API_KEY);
      await dialog.getByRole("button", { name: "保存" }).click();
      await expect(dialog.getByText("已保存。")).toBeVisible();
      await window.keyboard.press("Escape");
    } finally {
      await app1.close();
    }

    const app2 = await launchPackaged(fixture.userDataDir);
    try {
      const window = await app2.firstWindow();
      await expect(window.getByRole("treeitem", { name: /笔记/ })).toBeVisible({
        timeout: 15_000,
      });
      await window.getByRole("treeitem", { name: /笔记/ }).click();
      await expect(
        window.locator(".editor__content .ProseMirror"),
      ).toContainText("升级前正文。", { timeout: 15_000 });
      await window.getByLabel("设置").click();
      const dialog = window.getByRole("dialog", { name: "设置" });
      await expect(dialog.getByLabel("API Key")).toHaveValue(API_KEY);
    } finally {
      await app2.close();
      await fixture.cleanup();
    }
  });
});
