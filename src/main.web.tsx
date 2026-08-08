/**
 * Web 装配根（R005 阶段 2，Bootstrap 拆分）：唯一允许 import
 * infrastructure 的生产入口（架构测试强制）。创建 Web 运行时并挂载
 * 应用；平台差异全部收敛在 platform/web，挂载逻辑经
 * bootstrap/mountApplication 与未来 Desktop 装配根共享。
 */
import { createWebRuntime } from "./platform/web/createWebRuntime";
import { mountApplication } from "./bootstrap/mountApplication";

const runtime = createWebRuntime();
mountApplication(
  document.getElementById("root") as HTMLElement,
  runtime.services,
);
