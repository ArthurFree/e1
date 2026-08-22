// @vitest-environment node
/**
 * R008 Stage 0（§7.4）：构建级门禁——Electron Main/Preload 的第三方
 * external 必须全部声明在 production dependencies（chokidar 从
 * devDependencies 移入 dependencies 的回归锁）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  extractExternals,
  thirdPartyExternals,
} from "./verifyElectronRuntimeDeps.mjs";

const buildScript = readFileSync(
  new URL("./build-electron.mjs", import.meta.url),
  "utf8",
);
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

describe("Electron external 运行时依赖门禁（R008 §7.4）", () => {
  it("提取构建脚本的 external 列表（含 chokidar）", () => {
    expect(extractExternals(buildScript)).toContain("electron");
    expect(thirdPartyExternals(buildScript)).toContain("chokidar");
  });

  it("全部第三方 external 均声明在 production dependencies", () => {
    const thirdParty = thirdPartyExternals(buildScript);
    const missing = thirdParty.filter(
      (name) => !(name in (pkg.dependencies ?? {})),
    );
    expect(missing).toEqual([]);
    // electron 本身由运行时提供，不要求声明。
    expect(thirdParty).not.toContain("electron");
  });

  it("chokidar 不在 devDependencies（防止被移回）", () => {
    expect(pkg.dependencies.chokidar).toBeTruthy();
    expect(pkg.devDependencies?.chokidar).toBeUndefined();
  });
});
