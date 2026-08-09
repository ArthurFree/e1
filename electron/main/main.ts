// R006 阶段 0：Electron 主进程入口。
import { app, BrowserWindow } from "electron";
import { createMainWindow } from "./window.js";
import { registerIpcHandlers } from "./ipc/index.js";

void app.whenReady().then(() => {
  // R006 阶段 1：注册 vault/note/asset 三组 IPC handler。
  registerIpcHandlers();
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
