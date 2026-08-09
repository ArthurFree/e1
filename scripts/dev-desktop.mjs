// R006 阶段 0：桌面开发编排脚本（npm run dev:desktop）。
// 工作方式（不引 concurrently/wait-on）：
//   ① spawn Vite dev server（5173 端口，strictPort）；
//   ② esbuild context().watch() 监听 electron/ 主进程与预加载源码，输出 dist-electron/；
//   ③ 轮询 fetch http://localhost:5173 直至可访问（30s 超时）；
//   ④ spawn Electron 二进制（createRequire 取 electron 包导出的二进制路径），
//     env 注入 E1_DEV_SERVER_URL=http://localhost:5173；
// Electron 退出 → 杀掉 vite 与 esbuild watch 后退出；SIGINT/SIGTERM 联动清理。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { context } from "esbuild";

const require = createRequire(import.meta.url);
const electronBin = require("electron");
const DEV_SERVER_URL = "http://localhost:5173";
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

// 与 scripts/build-electron.mjs 相同的构建配置。
const mainOptions = {
  entryPoints: ["electron/main/main.ts"],
  outfile: "dist-electron/main.mjs",
  format: "esm",
  platform: "node",
  bundle: true,
  external: ["electron"],
};
const preloadOptions = {
  entryPoints: ["electron/preload/preload.ts"],
  outfile: "dist-electron/preload.cjs",
  format: "cjs",
  platform: "node",
  bundle: true,
  external: ["electron"],
};

const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

// ② esbuild watch（context API 先做一次全量构建再进入监听）。
const contexts = await Promise.all([
  context(mainOptions),
  context(preloadOptions),
]);
await Promise.all(contexts.map((ctx) => ctx.watch()));

// ① Vite dev server。
const vite = spawn(
  npmCmd,
  ["run", "dev:web", "--", "--port", "5173", "--strictPort"],
  {
    stdio: "inherit",
  },
);
children.push(vite);
vite.on("exit", (code) => {
  if (!shuttingDown) {
    console.error(`[dev-desktop] vite 退出（code=${code}），联动关闭`);
    shutdown(code ?? 1);
  }
});

// ③ 等待 dev server 可访问（30s 超时）。
const deadline = Date.now() + 30_000;
let ready = false;
while (Date.now() < deadline) {
  try {
    const res = await fetch(DEV_SERVER_URL);
    if (res.ok) {
      ready = true;
      break;
    }
  } catch {
    // dev server 尚未就绪，继续轮询。
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
}
if (!ready) {
  console.error(`[dev-desktop] 等待 ${DEV_SERVER_URL} 超时（30s），退出`);
  shutdown(1);
}

// ④ 启动 Electron。
const electron = spawn(electronBin, ["."], {
  stdio: "inherit",
  env: { ...process.env, E1_DEV_SERVER_URL: DEV_SERVER_URL },
});
children.push(electron);
electron.on("exit", (code) => {
  console.log(`[dev-desktop] electron 退出（code=${code}）`);
  shutdown(code ?? 0);
});
