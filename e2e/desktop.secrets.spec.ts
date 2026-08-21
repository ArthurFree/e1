// R008 Stage 1（§17.4）：Desktop Native Secret Store E2E（Playwright _electron，生产模式）。
// G10 黄金路径：API Key 保存 → secrets.json 密文落盘（无明文）→ 重启仍存在
// （安全 backend；CI Linux 等无安全 backend 环境按 mode 条件跳过，
//  此时降级语义由 G11 覆盖）。
// G11 黄金路径：env E1_SECRET_BACKEND_FORCE=basic_text 模拟不安全 backend →
// session-only（绝不落盘）→ 重启后 key 不存在。
// describe 以「桌面冒烟」为前缀：默认 test:e2e 经 --grep-invert 排除。
import { test, expect, _electron as electron } from "@playwright/test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requireDesktopArtifacts } from "./desktopArtifacts";

/** 桥的最小结构视图（page.evaluate 内局部断言使用）。 */
interface SecretBridge {
  get(input: { name: string }): Promise<string | null>;
  set(input: { name: string; value: string }): Promise<null>;
  remove(input: { name: string }): Promise<null>;
  getStatus(): Promise<{ mode: string; backend?: string; reason?: string }>;
}

test.describe("桌面冒烟：Native Secret Store（R008 Stage 1）", () => {
  test.beforeAll(() => {
    requireDesktopArtifacts();
  });

  test("@golden G10：API Key 保存 → 密文落盘（无明文）→ 重启仍存在（安全 backend）", async () => {
    const userDataDir = await mkdtemp(
      path.join(os.tmpdir(), "e1-userdata-g10-"),
    );
    const launch = () =>
      electron.launch({
        args: ["."],
        env: { ...process.env, E1_USER_DATA_DIR: userDataDir },
      });

    const app1 = await launch();
    try {
      const window1 = await app1.firstWindow();
      const status = await window1.evaluate(async () => {
        const secret = (window as unknown as { e1: { secret: SecretBridge } })
          .e1.secret;
        await secret.set({ name: "ai.apiKey", value: "sk-e2e-g10" });
        return secret.getStatus();
      });
      // CI Linux 通常只有 basic_text → session-only：G10 的安全持久语义
      // 在无安全 backend 环境不成立，跳过（降级语义由 G11 覆盖）。
      test.skip(
        status.mode !== "secure-persistent",
        `当前环境无安全 secret backend（mode=${status.mode}）`,
      );
      // 落盘为密文：secrets.json 存在且不含原始 API Key。
      const raw = await readFile(
        path.join(userDataDir, "secrets.json"),
        "utf8",
      );
      expect(raw).not.toContain("sk-e2e-g10");
      const parsed = JSON.parse(raw) as {
        version: number;
        entries: Record<string, { ciphertext: string }>;
      };
      expect(parsed.version).toBe(1);
      expect(parsed.entries["ai.apiKey"]?.ciphertext).toBeTruthy();
    } finally {
      await app1.close();
    }

    // 重启（同一 userData）：key 仍在。
    const app2 = await launch();
    try {
      const window2 = await app2.firstWindow();
      const value = await window2.evaluate(() =>
        (window as unknown as { e1: { secret: SecretBridge } }).e1.secret.get({
          name: "ai.apiKey",
        }),
      );
      expect(value).toBe("sk-e2e-g10");
    } finally {
      await app2.close();
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("@golden G11：backend 不安全（basic_text）→ session-only 不落盘 → 重启后 key 不存在", async () => {
    const userDataDir = await mkdtemp(
      path.join(os.tmpdir(), "e1-userdata-g11-"),
    );
    const launch = () =>
      electron.launch({
        args: ["."],
        env: {
          ...process.env,
          E1_USER_DATA_DIR: userDataDir,
          // Main 侧注入点：强制按 basic_text 判定 backend（模拟不安全环境）。
          E1_SECRET_BACKEND_FORCE: "basic_text",
        },
      });

    const app1 = await launch();
    try {
      const window1 = await app1.firstWindow();
      const result = await window1.evaluate(async () => {
        const secret = (window as unknown as { e1: { secret: SecretBridge } })
          .e1.secret;
        await secret.set({ name: "ai.apiKey", value: "sk-e2e-g11" });
        return {
          status: await secret.getStatus(),
          value: await secret.get({ name: "ai.apiKey" }),
        };
      });
      expect(result.status.mode).toBe("session-only");
      expect(result.status.backend).toBe("basic_text");
      // 会话内可用（内存兜底）。
      expect(result.value).toBe("sk-e2e-g11");
      // 绝不落盘（不明文/弱保护写文件）。
      await expect(
        access(path.join(userDataDir, "secrets.json")),
      ).rejects.toThrow();
    } finally {
      await app1.close();
    }

    // 重启（同一 userData、同一不安全 backend）：session Map 丢失，key 不存在。
    const app2 = await launch();
    try {
      const window2 = await app2.firstWindow();
      const value = await window2.evaluate(() =>
        (window as unknown as { e1: { secret: SecretBridge } }).e1.secret.get({
          name: "ai.apiKey",
        }),
      );
      expect(value).toBeNull();
    } finally {
      await app2.close();
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
});
