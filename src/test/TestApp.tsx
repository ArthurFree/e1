/**
 * 测试装配（R003 阶段 5）：与生产一致的容器注入——
 * IndexedDB 服务容器（fake-indexeddb）+ AppProvider。
 * 需要真实仓储与应用状态的组件测试统一用它包裹渲染。
 */
import type { ReactNode } from "react";
import { AppProvider } from "../state/AppState";
import { AppServicesProvider } from "../state/AppServicesProvider";
import { createBrowserAppServices } from "../infrastructure/browserServices";

export function TestApp({ children }: { children: ReactNode }) {
  return (
    <AppServicesProvider services={createBrowserAppServices()}>
      <AppProvider>{children}</AppProvider>
    </AppServicesProvider>
  );
}
