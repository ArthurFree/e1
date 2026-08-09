/**
 * Desktop 装配根（R006 阶段 1）：desktop.html 的入口，与 main.web.tsx
 * 同构——创建 Desktop 运行时（fake adapter + 桌面能力矩阵）并经共享
 * bootstrap 挂载应用。getDesktopApi 在纯浏览器误开 desktop.html 时
 * 显式抛错（见 platform/desktop/desktopApi.ts）。
 */
import { createDesktopRuntime } from "./platform/desktop/createDesktopRuntime";
import { getDesktopApi } from "./platform/desktop/desktopApi";
import { mountApplication } from "./bootstrap/mountApplication";

const runtime = createDesktopRuntime(getDesktopApi());
mountApplication(
  document.getElementById("root") as HTMLElement,
  runtime.services,
);
