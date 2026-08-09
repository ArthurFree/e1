// R006 阶段 0：Electron 主进程窗口创建。
// 主进程以 ESM 运行（package.json 为 "type": "module"，入口 dist-electron/main.mjs，
// Electron ≥ 28 支持 ESM 主进程），路径推导经 import.meta.url；
// sandbox 预加载脚本必须是 CJS（构建产物 dist-electron/preload.cjs）。
import { BrowserWindow } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(here, "preload.cjs"),
    },
  });

  // 安全惯例：渲染进程 window.open 一律拒绝开新窗。
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  const devServerUrl = process.env.E1_DEV_SERVER_URL;
  if (devServerUrl) {
    // 开发：加载 Desktop 入口（R006 阶段 1 起为 desktop.html，
    // preload 注入 window.e1 桌面桥；Web 入口 index.html 仅供浏览器）。
    void win.loadURL(`${devServerUrl}/desktop.html`);
  } else {
    // 生产：加载 vite 构建产物（vite base 为 "./"，file:// 下相对路径可用）。
    void win.loadFile(join(here, "../dist/desktop.html"));
  }
  return win;
}
