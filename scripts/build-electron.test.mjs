// R008 Stage 0（§7.4）：Electron 构建 external 依赖门禁。
// scripts/build-electron.mjs 的 external 包在运行时从 node_modules 解析，
// 因此除 "electron" 外必须全部声明在 package.json dependencies（而非
// devDependencies）且真实可解析——否则 production 裁剪（npm prune
// --omit=dev）后 Main bundle 启动即崩。chokidar（Watcher）即由此迁入
// dependencies；本测试防止后续新增 external 时重蹈覆辙。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

/** 解析 build-electron.mjs 全部 external 列表（main + preload 包，去重）。 */
function readExternals() {
  const src = readFileSync(join(here, "build-electron.mjs"), "utf8");
  const names = new Set();
  for (const match of src.matchAll(/external:\s*\[([^\]]*)\]/g)) {
    for (const pkg of match[1].matchAll(/"([^"]+)"/g)) names.add(pkg[1]);
  }
  // "electron" 由 Electron 运行时注入，不经过 node_modules。
  names.delete("electron");
  return [...names];
}

function readPackageJson() {
  return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
}

describe("Electron external runtime dependencies（R008 §7.4）", () => {
  it("除 electron 外的 external 均声明在 dependencies 且不在 devDependencies", () => {
    const pkg = readPackageJson();
    const externals = readExternals();
    // 门禁有效性自证：当前至少 chokidar 一个 runtime external。
    expect(externals.length).toBeGreaterThan(0);
    for (const name of externals) {
      expect(
        pkg.dependencies?.[name],
        `${name} 是 runtime external，必须声明在 dependencies`,
      ).toBeTruthy();
      expect(
        pkg.devDependencies?.[name],
        `${name} 不得留在 devDependencies（production 裁剪后丢失）`,
      ).toBeUndefined();
    }
  });

  it("external runtime dependency 在 node_modules 可解析", () => {
    for (const name of readExternals()) {
      expect(
        () => require.resolve(name),
        `${name} 必须能从 node_modules 解析`,
      ).not.toThrow();
    }
  });

  it("chokidar（Vault Watcher runtime dependency）在 production dependencies", () => {
    expect(readPackageJson().dependencies?.chokidar).toBeTruthy();
  });
});
