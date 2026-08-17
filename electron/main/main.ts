// R006 阶段 0：Electron 主进程入口。
import { app, BrowserWindow } from "electron";
import { createMainWindow } from "./window.js";
import { registerIpcHandlers } from "./ipc/index.js";
import type { VaultWatcherService } from "./watcher/VaultWatcher.js";
import {
  registerE1AssetProtocol,
  registerE1AssetScheme,
} from "./protocol/e1AssetProtocol.js";

// e1-asset:// 必须在 app.ready 之前声明为特权协议（R006-C5 FR-21）。
registerE1AssetScheme();

// 测试隔离（R006 阶段 2）：E1_USER_DATA_DIR 覆盖 userData 目录，
// 冒烟测试因此获得独立的 recent-vaults.json / localStorage，
// 不污染开发数据、不受既有注册表影响。生产与开发不设该变量。
if (process.env.E1_USER_DATA_DIR) {
  app.setPath("userData", process.env.E1_USER_DATA_DIR);
}

// R007 阶段 3：watcher 句柄提升为模块级，before-quit 时关闭全部监听。
let vaultWatchers: VaultWatcherService | null = null;

void app.whenReady().then(() => {
  const vaultRoots = registerIpcHandlers();
  vaultWatchers = vaultRoots.watchers;
  registerE1AssetProtocol(vaultRoots);
  createMainWindow();

  // macOS 惯例：点击 Dock 图标且已无窗口时重建窗口。
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

// macOS 惯例：非 darwin 平台全部窗口关闭即退出。
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// 退出前关闭全部 vault 监听（chokidar 句柄不随进程退出自动 await）。
app.on("before-quit", () => {
  void vaultWatchers?.closeAll();
});
