/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // R006 阶段 0：Electron 生产模式经 file:// 加载 dist 产物，
  // 资源须为相对路径；Web dev/preview 下 "./" 等价于 "/"，行为不变。
  base: "./",
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        // R006 阶段 1：多页构建——index.html（Web 入口）+
        // desktop.html（Electron 桌面入口，加载 main.desktop.tsx）。
        main: fileURLToPath(new URL("index.html", import.meta.url)),
        desktop: fileURLToPath(new URL("desktop.html", import.meta.url)),
      },
    },
  },
  test: {
    // 自定义 jsdom 环境（R009 Stage 0.1）：teardown 前先行排空挂起的宏任务，
    // 根治 React dev 调度回调在 jsdom 销毁后访问 window 的 unhandled error。
    environment: "./src/test/jsdomEnvironment.ts",
    setupFiles: ["./src/test/setup.ts"],
    // 测试临时目录收口到项目内 test-results/tmp（每次运行前清空），
    // 语义见 src/test/projectTmp.ts。
    globalSetup: ["./src/test/globalSetup.ts"],
    // wall-clock 基准（*perf-wallclock.test.ts）由 npm run test:perf 单独跑，
    // 不进 npm test / ci——fake-indexeddb 耗时在 CI runner 上会抖动失败。
    // 不用 *.bench.*：Vitest 会把含 .bench. 的文件当成 benchmark 模式跳过。
    exclude: ["e2e/**", "node_modules/**", "**/*perf-wallclock.test.ts"],
  },
});
