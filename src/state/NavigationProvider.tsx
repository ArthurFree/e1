/**
 * 导航状态 Provider（R004 阶段 4）：view / selectedPageId /
 * titleFocusPageId 的所有者，负责主区域路由与文档打开/定位。
 *
 * 跨域依赖不复制实现：
 * - 路由持久化与 routePersistenceStatus 来自 PreferencesProvider 的内部
 *   通道（usePreferencesRoute）；
 * - 跨知识库打开/定位所需的会话加载与会话快照来自 WorkspaceProvider 的
 *   内部通道（useWorkspaceInternals）；
 * - 反向（工作区动作触发导航）经 navBridge 注册的命令完成，挂载时注册、
 *   卸载时注销。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAppServices } from "./AppServicesProvider";
import {
  NavigationCommandContext,
  NavigationStateContext,
  type MainView,
  type NavigationCommandContextValue,
  type NavigationStateContextValue,
} from "./NavigationContext";
import { usePreferencesRoute } from "./PreferencesProvider";
import { useWorkspaceInternals } from "./WorkspaceProvider";
import type { NavigationBridge, NavigationCommands } from "./navigationBridge";

interface NavigationProviderProps {
  /** 导航命令桥：向工作区域暴露导航命令（AppProviders 创建）。 */
  navBridge: NavigationBridge;
  children: ReactNode;
}

/** 导航状态 Provider：公开状态/命令双 Context（R004 §4.6，聚合形状不变）。 */
export function NavigationProvider({
  navBridge,
  children,
}: NavigationProviderProps) {
  const services = useAppServices();
  const workspaceQueries = services.queries.workspace;
  const workspaceCommands = services.commands.workspace;
  const { persistRoute, routePersistenceStatus } = usePreferencesRoute();
  const workspaceInternals = useWorkspaceInternals();
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [view, setView] = useState<MainView>("start");
  const [titleFocusPageId, setTitleFocusPageId] = useState<string | null>(null);
  // 选中页镜像：命令桥内的 exitDocumentIfSelected 经 ref 读取，保持引用稳定。
  const selectedPageIdRef = useRef(selectedPageId);
  selectedPageIdRef.current = selectedPageId;

  const selectPage = useCallback(
    (id: string | null) => {
      setSelectedPageId(id);
      // 仅在确实选中页面时才切视图并持久化路由；传 null 只是清除选中。
      const workspaceId = workspaceInternals.getSnapshot().workspaceId;
      if (id && workspaceId) {
        setView("document");
        persistRoute({ view: "document", workspaceId, pageId: id });
      }
    },
    [workspaceInternals, persistRoute],
  );

  const showStart = useCallback(() => {
    setView("start");
    persistRoute({ view: "start" });
  }, [persistRoute]);

  const showRecent = useCallback(() => {
    setView("recent");
    persistRoute({ view: "recent" });
  }, [persistRoute]);

  const showFavorites = useCallback(() => {
    setView("favorites");
    persistRoute({ view: "favorites" });
  }, [persistRoute]);

  const clearTitleFocus = useCallback(() => {
    setTitleFocusPageId(null);
  }, []);

  const showWorkspaceHome = useCallback(() => {
    const workspaceId = workspaceInternals.getSnapshot().workspaceId;
    if (!workspaceId) return;
    setView("workspace");
    persistRoute({ view: "workspace", workspaceId });
  }, [workspaceInternals, persistRoute]);

  const openDocument = useCallback(
    async (pageId: string) => {
      let { workspaceId: wsId } = workspaceInternals.getSnapshot();
      const { pages } = workspaceInternals.getSnapshot();
      const inState = pages.some((p) => p.id === pageId);
      let target = pages.find((p) => p.id === pageId);
      if (!target) {
        // 不在当前知识库镜像中（跨知识库打开）：回退全量查询定位。
        target = await workspaceQueries.findPage(pageId);
      }
      if (!target || target.kind !== "document") return;
      if (target.workspaceId !== wsId) {
        // 跨知识库：原子加载目标库会话；未 ready 前不进入文档视图。
        wsId = target.workspaceId;
        const data = await workspaceInternals.loadSession(wsId);
        if (!data) return;
        void workspaceCommands.setLastOpened(wsId, Date.now());
      } else if (!inState && wsId) {
        // 页面由命令服务直接创建（模板/AI 流程），当前列表未包含时同步刷新。
        await workspaceInternals.loadPages(wsId);
      }
      if (!wsId) return;
      setSelectedPageId(pageId);
      setView("document");
      persistRoute({ view: "document", workspaceId: wsId, pageId });
    },
    [workspaceInternals, workspaceQueries, workspaceCommands, persistRoute],
  );

  const locatePage = useCallback(
    async (pageId: string) => {
      let { workspaceId: wsId } = workspaceInternals.getSnapshot();
      const { pages } = workspaceInternals.getSnapshot();
      let target = pages.find((p) => p.id === pageId);
      if (!target) {
        // 与 openDocument 相同：目标可能在其他知识库，回退全量查询。
        target = await workspaceQueries.findPage(pageId);
      }
      if (!target) return;
      if (target.workspaceId !== wsId) {
        // 跨知识库定位：先原子加载所属知识库会话再在树中高亮。
        wsId = target.workspaceId;
        const data = await workspaceInternals.loadSession(wsId);
        if (!data) return;
        void workspaceCommands.setLastOpened(wsId, Date.now());
      }
      if (!wsId) return;
      // 与 openDocument 的区别：主区域停在知识库首页，由页面树高亮目标。
      setSelectedPageId(pageId);
      setView("workspace");
      persistRoute({ view: "workspace", workspaceId: wsId });
    },
    [workspaceInternals, workspaceQueries, workspaceCommands, persistRoute],
  );

  // —— 注册到命令桥：供工作区域的跨域动作触发导航（R004 阶段 4）——

  const restoreRoute = useCallback(
    (nextView: MainView, pageId: string | null) => {
      setView(nextView);
      setSelectedPageId(pageId);
    },
    [],
  );

  const showWorkspaceHomeFor = useCallback(
    (workspaceId: string) => {
      setSelectedPageId(null);
      setView("workspace");
      persistRoute({ view: "workspace", workspaceId });
    },
    [persistRoute],
  );

  const openDocumentView = useCallback(
    (workspaceId: string, pageId: string, focusTitle: boolean) => {
      setSelectedPageId(pageId);
      // 新文档标题为空占位，请求 TitleEditor 自动聚焦便于立即改名。
      if (focusTitle) setTitleFocusPageId(pageId);
      setView("document");
      persistRoute({ view: "document", workspaceId, pageId });
    },
    [persistRoute],
  );

  const exitDocumentIfSelected = useCallback(
    (pageId: string, workspaceId: string) => {
      if (selectedPageIdRef.current !== pageId) return;
      setSelectedPageId(null);
      setView("workspace");
      persistRoute({ view: "workspace", workspaceId });
    },
    [persistRoute],
  );

  // 挂载时注册命令、卸载时注销；子 effect 先于父 effect 执行，
  // 工作区域的异步动作拿到的一定是已注册的命令。
  useEffect(() => {
    const commands: NavigationCommands = {
      restoreRoute,
      showWorkspaceHome: showWorkspaceHomeFor,
      openDocumentView,
      exitDocumentIfSelected,
    };
    navBridge.commands = commands;
    return () => {
      navBridge.commands = null;
    };
  }, [
    navBridge,
    restoreRoute,
    showWorkspaceHomeFor,
    openDocumentView,
    exitDocumentIfSelected,
  ]);

  const stateValue = useMemo<NavigationStateContextValue>(
    () => ({
      view,
      selectedPageId,
      titleFocusPageId,
      routePersistenceStatus,
    }),
    [view, selectedPageId, titleFocusPageId, routePersistenceStatus],
  );

  // 命令成员全部引用稳定，本 value 恒定：路由变化不会引起纯命令
  // 消费者重渲染（R004 §4.6）。
  const commandValue = useMemo<NavigationCommandContextValue>(
    () => ({
      selectPage,
      openDocument,
      locatePage,
      showStart,
      showRecent,
      showFavorites,
      showWorkspaceHome,
      clearTitleFocus,
    }),
    [
      selectPage,
      openDocument,
      locatePage,
      showStart,
      showRecent,
      showFavorites,
      showWorkspaceHome,
      clearTitleFocus,
    ],
  );

  return (
    <NavigationStateContext.Provider value={stateValue}>
      <NavigationCommandContext.Provider value={commandValue}>
        {children}
      </NavigationCommandContext.Provider>
    </NavigationStateContext.Provider>
  );
}
