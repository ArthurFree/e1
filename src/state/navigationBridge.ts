/**
 * 跨域命令桥（R004 阶段 4）：WorkspaceProvider 的跨域动作（切换/创建
 * 知识库、新建/删除页面）需要触发导航，而 NavigationProvider 嵌套在其
 * 内层、无法被外层直接消费。桥对象由 AppProviders 创建并作为 prop 传给
 * 两者，NavigationProvider 挂载时注册命令实现、卸载时注销。
 *
 * 只承载「工作区 → 导航」一个方向；「导航 → 工作区/偏好」由内层
 * NavigationProvider 直接消费外层 Provider 的内部 Context 实现。
 */
import type { MainView } from "./NavigationContext";

/** 导航域提供给工作区域的命令集。 */
export interface NavigationCommands {
  /** 恢复初始路由：仅设置视图与选中页面，不写回持久化路由。 */
  restoreRoute(view: MainView, pageId: string | null): void;
  /** 进入指定知识库首页：清空选中并持久化路由。 */
  showWorkspaceHome(workspaceId: string): void;
  /** 打开文档视图（可选请求标题聚焦）并持久化路由。 */
  openDocumentView(
    workspaceId: string,
    pageId: string,
    focusTitle: boolean,
  ): void;
  /** 若当前打开的正是指定文档，退出到知识库首页（删除/彻底删除时）。 */
  exitDocumentIfSelected(pageId: string, workspaceId: string): void;
}

/**
 * 桥本体：NavigationProvider 挂载前/卸载后 commands 为 null。
 * 工作区动作都在异步等待之后调用命令（初始加载亦然），此时导航域
 * 必然已注册；仍判空以防万一。
 */
export interface NavigationBridge {
  commands: NavigationCommands | null;
}

export function createNavigationBridge(): NavigationBridge {
  return { commands: null };
}
