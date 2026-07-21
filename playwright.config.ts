import { defineConfig } from "@playwright/test";

/**
 * 端到端与视觉回归配置。
 * 基准视口 1440 × 900（见 docs/ui-spec.md）；浏览器二进制安装在项目内
 * （PLAYWRIGHT_BROWSERS_PATH=0），由 npm script 统一注入。
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
  },
  expect: {
    toHaveScreenshot: {
      // 抗锯齿与字体的亚像素差异容忍；动态元素在各用例中单独 mask。
      maxDiffPixelRatio: 0.01,
      animations: "disabled",
      caret: "hide",
    },
  },
  webServer: {
    command: "npm run dev -- --port 5173 --strictPort",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
