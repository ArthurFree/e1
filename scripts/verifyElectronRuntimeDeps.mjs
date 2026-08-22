// R008 Stage 0（§7.4）：Electron Main 的第三方 external 必须声明在
// production dependencies——esbuild bundle 标记为 external 的包在运行时
// 从 node_modules 解析，若只在 devDependencies，`npm prune --omit=dev`
//（打包/分发场景）后 Main 会因 ERR_MODULE_NOT_FOUND 无法启动。
//
// 用法：
//   node scripts/verifyElectronRuntimeDeps.mjs           # 元数据校验（声明层）
//   node scripts/verifyElectronRuntimeDeps.mjs --resolve # 额外做真实模块解析
//                                                        #（npm prune --omit=dev 后）
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const buildScript = readFileSync(
  new URL("./build-electron.mjs", import.meta.url),
  "utf8",
);

/** 从构建脚本提取全部 external 条目（跨多个 build 调用去重）。 */
export function extractExternals(source) {
  const names = [];
  for (const match of source.matchAll(/external:\s*\[([^\]]*)\]/g)) {
    for (const raw of match[1].split(",")) {
      const name = raw.trim().replace(/^["']|["']$/g, "");
      if (name) names.push(name);
    }
  }
  return [...new Set(names)];
}

export function thirdPartyExternals(source) {
  return extractExternals(source).filter((name) => name !== "electron");
}

const thirdParty = thirdPartyExternals(buildScript);

/** 声明层校验：返回缺失 production dependency 声明的 external 列表。 */
export function missingDependencyDeclarations(externals, dependencies) {
  return externals.filter((name) => !(name in (dependencies ?? {})));
}

// 仅作为 CLI 直接执行时跑校验/解析（被测试 import 时不触发副作用）。
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const missing = missingDependencyDeclarations(thirdParty, pkg.dependencies);
  if (missing.length > 0) {
    console.error(
      `Electron Main external 缺少 production dependency 声明：${missing.join(", ")}`,
    );
    process.exit(1);
  }

  if (process.argv.includes("--resolve")) {
    const require = createRequire(
      new URL("../dist-electron/main.mjs", import.meta.url),
    );
    for (const name of thirdParty) {
      require.resolve(name);
    }
    console.log(
      `Electron external 运行时解析通过（${thirdParty.join(", ") || "无第三方 external"}）`,
    );
  } else {
    console.log(
      `Electron external 依赖声明校验通过（${thirdParty.join(", ") || "无第三方 external"}）`,
    );
  }
}
