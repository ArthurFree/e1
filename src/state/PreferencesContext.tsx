/**
 * 偏好状态域（R003 阶段 6）：主题、侧栏宽度、AI 配置。
 * Provider 由 AppState 的 AppProvider 统一供给，本文件定义契约与读取入口。
 */
import { createContext, useContext } from "react";
import type { AIConfig, Preferences } from "../domain/types";

/** 偏好域暴露给组件的状态与动作。 */
export interface PreferencesContextValue {
  preferences: Preferences;
  /** 更新主题偏好并持久化。 */
  setTheme(theme: Preferences["theme"]): Promise<void>;
  /** 更新侧栏宽度偏好并持久化（拖动期间内存实时更新，防抖落盘）。 */
  setSidebarWidth(width: number): Promise<void>;
  /** 保存或清除 AI 配置（传 null 清除）。 */
  setAIConfig(config: AIConfig | null): Promise<void>;
}

export const PreferencesContext = createContext<PreferencesContextValue | null>(
  null,
);

/** 读取偏好域；在 Provider 外调用直接抛错。 */
export function usePreferences(): PreferencesContextValue {
  const ctx = useContext(PreferencesContext);
  if (!ctx) throw new Error("usePreferences 必须在 AppProvider 内使用");
  return ctx;
}
