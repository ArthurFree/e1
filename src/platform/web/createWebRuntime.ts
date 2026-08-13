/**
 * Web 运行时装配（R005 阶段 2）：IndexedDB 服务容器 + Web 能力矩阵。
 * main.web.tsx 是唯一调用点；capabilities 已合并进 services
 * （createBrowserAppServices 单例内含 webCapabilities），此处原样透出，
 * 供装配根在不经 React 的场景读取能力矩阵。
 */
import type { AppServices } from "../../application/AppServices";
import type { RuntimeCapabilities } from "../../runtime/RuntimeCapabilities";
import { createBrowserAppServices } from "./createBrowserServices";
import { webCapabilities } from "./webCapabilities";

export interface WebRuntime {
  services: AppServices;
  capabilities: RuntimeCapabilities;
}

export function createWebRuntime(): WebRuntime {
  return {
    services: createBrowserAppServices(),
    capabilities: webCapabilities,
  };
}
