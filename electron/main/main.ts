// R006 阶段 0：Electron 主进程入口。
import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { createMainWindow } from "./window.js";
import {
  registerIpcHandlers,
  type RegisterIpcHandlersDeps,
} from "./ipc/index.js";
import { createRecordingShell } from "./ipc/reveal.js";
import type { VaultWatcherService } from "./watcher/VaultWatcher.js";
import {
  registerE1AssetProtocol,
  registerE1AssetScheme,
} from "./protocol/e1AssetProtocol.js";
import { runLegacyUserDataMigration } from "./migration/LegacyUserDataMigration.js";

// R009 Stage 1（G2 产品身份冻结）：name=e1 / productName=E1 /
// appId=com.e1.notes / version=0.1.0。productName/appId 属 electron-builder
// 打包配置（Stage 2 接入）；本阶段显式 setName("E1") 锁定默认 userData
// 目录名（macOS ~/Library/Application Support/E1），避免 Stage 2 前后
// 行为漂移。必须在任何 app.getPath("userData") 之前调用。
app.setName("E1");

// e1-asset:// 必须在 app.ready 之前声明为特权协议（R006-C5 FR-21）。
registerE1AssetScheme();

// 测试隔离（R006 阶段 2）：E1_USER_DATA_DIR 覆盖 userData 目录，
// 冒烟测试因此获得独立的 recent-vaults.json / localStorage，
// 不污染开发数据、不受既有注册表影响。生产与开发不设该变量。
if (process.env.E1_USER_DATA_DIR) {
  app.setPath("userData", process.env.E1_USER_DATA_DIR);
}

// R009 Stage 0.2（§3.3）：桌面 E2E 置 E1_REVEAL_STUB=1 时，reveal 组改用
// 记录型 stub（不调真实 shell.showItemInFolder）——Linux CI（xvfb headless）
// 没有文件管理器，真实调用会挂起超时。stub 把解析后的绝对路径逐行写入
// userData/e2e-reveal-stub.log，E2E 据此断言 IPC 全链路。生产与开发不设该变量。
function revealStubDeps(): RegisterIpcHandlersDeps {
  if (process.env.E1_REVEAL_STUB !== "1") return {};
  return {
    shell: createRecordingShell(
      join(app.getPath("userData"), "e2e-reveal-stub.log"),
    ),
  };
}

// R007 阶段 3：watcher 句柄提升为模块级，before-quit 时关闭全部监听。
let vaultWatchers: VaultWatcherService | null = null;

void app.whenReady().then(async () => {
  // R009 Stage 1（§1.2 / G3）：legacy userData 一次性迁移必须在任何
  // VaultRegistry / vault-state / secrets 首次读取 userData 之前完成；
  // E1_USER_DATA_DIR 显式设置（桌面 E2E 测试隔离）时内部跳过。
  // 迁移失败不阻断启动——不写 marker，下次启动自动重试。
  await runLegacyUserDataMigration({
    userDataDir: app.getPath("userData"),
    appDataDir: app.getPath("appData"),
    log: (message) => console.warn(message),
  }).catch((error: unknown) => {
    console.warn("[LegacyUserDataMigration] 迁移流程异常（不阻断启动）", error);
  });
  const vaultRoots = registerIpcHandlers(revealStubDeps());
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
