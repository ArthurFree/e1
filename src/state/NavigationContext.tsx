/**
 * 导航状态域（R003 阶段 6）：主区域视图路由与选中页面。
 * Provider 由 AppState 的 AppProvider 统一供给，本文件定义契约与读取入口。
 */
import { createContext, useContext } from "react";

/** 主区域视图种类：与持久化路由 AppRoute.view 一一对应。 */
export type MainView =
  "start" | "recent" | "favorites" | "workspace" | "document";

/** 导航域暴露给组件的状态与动作。 */
export interface NavigationContextValue {
  /** 主区域视图：开始首页 / 最近 / 收藏 / 知识库首页 / 文档编辑。 */
  view: MainView;
  /** 当前打开的文档 ID；仅 view === "document" 时有意义。 */
  selectedPageId: string | null;
  /** 新建文档后需要聚焦标题的页面 ID（消费后清除）。 */
  titleFocusPageId: string | null;
  /** 路由/偏好异步写入状态：失败时为 "error"（R003 阶段 3）。 */
  routePersistenceStatus: "idle" | "error";
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

export const NavigationContext = createContext<NavigationContextValue | null>(
  null,
);

/** 读取导航域；在 Provider 外调用直接抛错。 */
export function useNavigation(): NavigationContextValue {
  const ctx = useContext(NavigationContext);
  if (!ctx) throw new Error("useNavigation 必须在 AppProvider 内使用");
  return ctx;
}
