/**
 * R006 阶段 1：Desktop 运行时装配（PoC 过渡——fake adapter）。
 *
 * 本阶段 services 基于内存容器（createInMemoryAppServices）：应用可完整
 * 运行但数据不持久、不读写真实文件。阶段 2 起逐 port 替换为 IPC-backed
 * 实现（note/asset 经 E1DesktopAPI 走 Main 文件系统，r006 §14–16）。
 *
 * api 参数（E1DesktopAPI）本阶段仅接线存档——供 selectDirectory 联调
 * 用例与后续 IPC-backed port 注入；fake adapter 不真正消费它。
 */
import type { AppServices } from "../../application/AppServices";
import type { RuntimeCapabilities } from "../../runtime/RuntimeCapabilities";
import { createInMemoryAppServices } from "../../infrastructure/memory/createInMemoryAppServices";
import { desktopCapabilities } from "./desktopCapabilities";
import type { E1DesktopAPI } from "./desktopApi";

export interface DesktopRuntime {
  services: AppServices;
  capabilities: RuntimeCapabilities;
}

export function createDesktopRuntime(api: E1DesktopAPI): DesktopRuntime {
  // 接线存档：api 供后续阶段 IPC-backed port 使用；当前仅断言桥存在。
  void api;
  const { services } = createInMemoryAppServices({
    capabilities: desktopCapabilities,
  });
  return { services, capabilities: desktopCapabilities };
}
