// R006 阶段 0/1：桌面端冒烟测试（Playwright _electron）。
// 以生产模式启动 Electron（不注入 E1_DEV_SERVER_URL，加载 dist/desktop.html），
// 因此需要先运行 npm run build:desktop 产出 dist/ 与 dist-electron/。
// 本 spec 不进默认 test:e2e 链路：默认脚本以 --grep-invert "桌面冒烟" 排除，
// 独立运行用 npm run test:e2e:desktop（--grep "桌面冒烟"）。
import { test, expect, _electron as electron } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

test.describe("桌面冒烟", () => {
  test.beforeAll(() => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const artifacts = [
      "dist/desktop.html",
      "dist-electron/main.mjs",
      "dist-electron/preload.cjs",
    ];
    test.skip(
      artifacts.some((p) => !existsSync(path.join(root, p))),
      "缺少 dist/ 或 dist-electron/ 产物，请先运行 npm run build:desktop",
    );
  });

  test("桌面冒烟：desktop 入口渲染 fake adapter UI + IPC 桥存在", async () => {
    const app = await electron.launch({ args: ["."] });
    const window = await app.firstWindow();

    // R006 阶段 1 预加载契约：contextBridge 暴露的完整 E1DesktopAPI
    // （platform + vault/note/asset 三组方法；Renderer 拿不到 ipcRenderer）。
    const bridge = await window.evaluate(() => {
      const e1 = (
        window as unknown as {
          e1?: {
            platform?: string;
            vault?: Record<string, unknown>;
            note?: Record<string, unknown>;
            asset?: Record<string, unknown>;
          };
        }
      ).e1;
      return {
        platform: e1?.platform,
        vault: Object.keys(e1?.vault ?? {}).sort(),
        note: Object.keys(e1?.note ?? {}).sort(),
        asset: Object.keys(e1?.asset ?? {}).sort(),
      };
    });
    expect(bridge).toEqual({
      platform: "desktop",
      vault: ["scan", "selectDirectory"],
      note: ["create", "read", "save"],
      asset: ["import", "pick", "resolveUrl"],
    });

    // desktop.html 经 fake adapter（内存容器）渲染应用 UI；开始首页标题
    // 与知识库无关，空库也渲染。页面树无种子数据不渲染，不做断言。
    await expect(window.getByRole("heading", { name: "开始" })).toBeVisible();

    await window.screenshot({ path: "test-results/desktop-smoke.png" });
    await app.close();
  });
});
