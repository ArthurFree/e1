/**
 * 应用服务注入（R003 阶段 5）：AppServices 容器的 React 入口。
 *
 * 生产环境在 main.tsx 注入 IndexedDB 实现（createBrowserAppServices），
 * 测试可注入内存实现（createInMemoryAppServices）；组件与状态层一律
 * 经 useAppServices() 取服务，不再直接 import infrastructure。
 */
import { createContext, useContext, type ReactNode } from "react";
import type { AppServices } from "../application/AppServices";

// 默认 null：配合 useAppServices 的守卫，让未装配的误用在开发期直接抛错。
const AppServicesContext = createContext<AppServices | null>(null);

/** 服务容器 Provider：必须位于 AppProvider 之上（AppState 经它取仓储）。 */
export function AppServicesProvider({
  services,
  children,
}: {
  services: AppServices;
  children: ReactNode;
}) {
  return (
    <AppServicesContext.Provider value={services}>
      {children}
    </AppServicesContext.Provider>
  );
}

/** 读取应用服务容器；在 AppServicesProvider 外调用直接抛错。 */
export function useAppServices(): AppServices {
  const services = useContext(AppServicesContext);
  if (!services) {
    throw new Error("useAppServices 必须在 AppServicesProvider 内使用");
  }
  return services;
}
