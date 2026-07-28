/**
 * 状态域组合层（R004 阶段 4）：四个状态域各自的 Provider 在此嵌套装配，
 * 替代原 AppState.tsx 的单一状态所有者。
 *
 * 嵌套顺序即依赖方向：Preferences → Workspace → Navigation → Overlay。
 * 内层 Provider 可消费外层的内部通道（导航域读偏好路由通道与工作区
 * 会话通道）；反向「工作区动作触发导航」经 navigationBridge 命令桥，
 * 避免循环依赖、也不复制跨域动作。
 */
import { useMemo, type ReactNode } from "react";
import { PreferencesProvider } from "./PreferencesProvider";
import { WorkspaceProvider } from "./WorkspaceProvider";
import { NavigationProvider } from "./NavigationProvider";
import { OverlayProvider } from "./OverlayContext";
import { createNavigationBridge } from "./navigationBridge";

/** 应用状态根：四个状态域 Provider 的唯一装配点。 */
export function AppProviders({ children }: { children: ReactNode }) {
  // 命令桥生命周期与整棵状态树一致，创建一次。
  const navBridge = useMemo(createNavigationBridge, []);
  return (
    <PreferencesProvider>
      <WorkspaceProvider navBridge={navBridge}>
        <NavigationProvider navBridge={navBridge}>
          <OverlayProvider>{children}</OverlayProvider>
        </NavigationProvider>
      </WorkspaceProvider>
    </PreferencesProvider>
  );
}
