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
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    exclude: ["e2e/**", "node_modules/**"],
  },
});
