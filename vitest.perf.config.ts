/**
 * 性能基准专用配置：只跑 *perf-wallclock.test.ts。
 * 不进 npm run ci；阈值仅作本地/受控 runner 趋势，不作 CI 硬门禁。
 * 不用 *.bench.* 文件名：Vitest 会把含 .bench. 的文件当成 benchmark 模式。
 */
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*perf-wallclock.test.ts"],
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
