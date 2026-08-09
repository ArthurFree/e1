// R006 阶段 0：Electron 主进程/预加载构建脚本（esbuild）。
// package.json 为 ESM，Electron ≥ 28 支持 ESM 主进程 → main 输出 dist-electron/main.mjs；
// sandbox 预加载脚本必须是 CJS → preload 输出 dist-electron/preload.cjs。
import { build } from "esbuild";

await build({
  entryPoints: ["electron/main/main.ts"],
  outfile: "dist-electron/main.mjs",
  format: "esm",
  platform: "node",
  bundle: true,
  external: ["electron"],
});

await build({
  entryPoints: ["electron/preload/preload.ts"],
  outfile: "dist-electron/preload.cjs",
  format: "cjs",
  platform: "node",
  bundle: true,
  external: ["electron"],
});

console.log("dist-electron/main.mjs 与 dist-electron/preload.cjs 构建完成");
