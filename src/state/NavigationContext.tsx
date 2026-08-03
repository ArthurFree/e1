/**
 * 导航状态域（R003 阶段 6 引入，R004 §4.6 细分）：主区域视图路由与选中
 * 页面。Provider 由 AppProviders 统一装配，本文件定义契约与读取入口。
 *
 * Context 细分为两片（R004 §4.6）：
 * - NavigationStateContext：状态切片（view/selectedPageId 等），随路由
 *   变化而更新；
 * - NavigationCommandContext：命令切片，全部动作引用稳定，路由变化不会
 *   引起纯命令消费者重渲染。
 * 聚合 hook useNavigation() 同时订阅两片，value 形状与细分前一致，供既
 * 有测试与尚未细分的调用方过渡使用；生产组件按需取其一或两者。
 */
import { createContext, useContext } from "react";

/** 主区域视图种类：与持久化路由 AppRoute.view 一一对应。 */
export type MainView =
  "start" | "recent" | "favorites" | "workspace" | "document";

/** 导航域的状态切片：随路由变化而更新。 */
export interface NavigationStateContextValue {
  /** 主区域视图：开始首页 / 最近 / 收藏 / 知识库首页 / 文档编辑。 */
  view: MainView;
  /** 当前打开的文档 ID；仅 view === "document" 时有意义。 */
  selectedPageId: string | null;
  /** 新建文档后需要聚焦标题的页面 ID（消费后清除）。 */
  titleFocusPageId: string | null;
  /** 路由/偏好异步写入状态：失败时为 "error"（R003 阶段 3）。 */
  routePersistenceStatus: "idle" | "error";
}

/** 导航域的命令切片：全部动作引用稳定。 */
export interface NavigationCommandContextValue {
  /** 选中当前知识库内的文档并切到文档视图；传 null 仅清除选中，不切换视图。 */
  selectPage(id: string | null): void;
  /** 打开文档（可跨知识库，自动切换）。 */
  openDocument(pageId: string): Promise<void>;
  /** 定位文档：切换到所属知识库并在树中高亮，主区域显示知识库首页。 */
  locatePage(pageId: string): Promise<void>;
  /** 全局开始首页。 */
  showStart(): void;
  /** 全局最近视图（最近编辑 / 最近浏览）。 */
  showRecent(): void;
  /** 全局收藏视图。 */
  showFavorites(): void;
  /** 当前知识库首页。 */
  showWorkspaceHome(): void;
  /** 清除标题聚焦标记。 */
  clearTitleFocus(): void;
}

/** 聚合形状（与细分前一致）：状态切片 + 命令切片。 */
export type NavigationContextValue = NavigationStateContextValue &
  NavigationCommandContextValue;

export const NavigationStateContext =
  createContext<NavigationStateContextValue | null>(null);

export const NavigationCommandContext =
  createContext<NavigationCommandContextValue | null>(null);

/** 读取导航状态切片；在 Provider 外调用直接抛错。 */
export function useNavigationState(): NavigationStateContextValue {
  const ctx = useContext(NavigationStateContext);
  if (!ctx) throw new Error("useNavigationState 必须在 AppProvider 内使用");
  return ctx;
}

/** 读取导航命令切片；在 Provider 外调用直接抛错。 */
export function useNavigationCommands(): NavigationCommandContextValue {
  const ctx = useContext(NavigationCommandContext);
  if (!ctx) throw new Error("useNavigationCommands 必须在 AppProvider 内使用");
  return ctx;
}

/**
 * 聚合读取导航域（状态 + 命令，形状不变）；同时订阅两片 Context，仅供
 * 既有测试与过渡调用方使用，生产组件应改用 useNavigationState /
 * useNavigationCommands 以获得更细的渲染粒度。
 */
export function useNavigation(): NavigationContextValue {
  return { ...useNavigationState(), ...useNavigationCommands() };
}
