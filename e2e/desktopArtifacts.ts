/**
 * Desktop E2E 产物门禁：本地缺产物时 skip（方便未 build 时跑其它套件），
 * CI 上缺产物必须失败（避免假绿）。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";

const ARTIFACTS = [
  "dist/desktop.html",
  "dist-electron/main.mjs",
  "dist-electron/preload.cjs",
] as const;

/** 在 describe 的 beforeAll 中调用：校验 build:desktop 产物。 */
export function requireDesktopArtifacts(): void {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const missing = ARTIFACTS.filter((p) => !existsSync(path.join(root, p)));
  if (missing.length === 0) return;

  const message = `缺少 Desktop 产物（${missing.join(", ")}），请先运行 npm run build:desktop`;
  if (process.env.CI) {
    throw new Error(message);
  }
  test.skip(true, message);
}
