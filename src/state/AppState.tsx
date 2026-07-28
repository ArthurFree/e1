/**
 * 兼容层（R004 阶段 4）：状态层已拆分为 PreferencesProvider /
 * WorkspaceProvider / NavigationProvider / OverlayProvider 四个独立的
 * 状态所有者，由 AppProviders 组合装配（见 AppProviders.tsx）。
 * 本文件仅保留既有导入路径，供未迁移的测试零改动运行；
 * 生产新代码请直接使用 useWorkspaceSession / useNavigation /
 * usePreferences / useOverlay 窄 hook。
 */
export { AppProviders as AppProvider } from "./AppProviders";
export { useApp } from "./legacy/useApp";
export type { AppState } from "./legacy/useApp";
export type { MainView } from "./NavigationContext";
export type { WorkspaceSessionStatus } from "./WorkspaceSessionContext";
