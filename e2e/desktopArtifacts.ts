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

/**
 * R009 Stage 3：解析当前平台的安装包可执行文件路径。
 * 目前只有 macOS arm64 产物约定（npm run dist:mac → release/mac-arm64/）；
 * 其它平台返回 null（Windows nsis 产物接入后在此扩展）。
 */
export function resolvePackagedExecutable(): string | null {
  const root = fileURLToPath(new URL("..", import.meta.url));
  if (process.platform === "darwin" && process.arch === "arm64") {
    return path.join(root, "release/mac-arm64/E1.app/Contents/MacOS/E1");
  }
  return null;
}

/**
 * 在 packaged spec 的 beforeAll 中调用：校验安装包产物。
 * 与 requireDesktopArtifacts 同一口径——本地缺产物 skip，CI 缺产物失败。
 */
export function requirePackagedArtifact(): void {
  const executable = resolvePackagedExecutable();
  if (executable && existsSync(executable)) return;

  const message = executable
    ? `缺少安装包产物（${executable}），请先运行 npm run dist:mac`
    : `当前平台 ${process.platform}/${process.arch} 暂无安装包产物约定（仅支持 macOS arm64）`;
  if (process.env.CI) {
    throw new Error(message);
  }
  test.skip(true, message);
}
