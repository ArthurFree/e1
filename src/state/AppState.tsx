/**
 * 应用全局状态层：UI 与基础设施之间的唯一桥梁。
 *
 * 架构位置：视图组件只通过 useApp() 读状态、触发动作；动作内部调用
 * 仓储接口（经 application 层服务）写入 IndexedDB，再以 dispatch 同步内存镜像，
 * 因此仓储实现可整体替换而不影响 UI（docs/architecture.md 的分层约束）。
 *
 * 关键设计：
 * - 知识库会话（workspaceId/pages/tags/pageTags）由 useReducer 持有：
 *   切换知识库时经 WorkspaceSessionService 一次原子加载，requestId 丢弃过期
 *   响应，三类数据在单次 dispatch 中提交，UI 永远不会看到新旧知识库混合态
 *   （R003 阶段 2）；
 * - pages / tags / workspaces 是 IndexedDB 的内存镜像：写操作先落库再刷新，
 *   保证刷新页面后状态可完整恢复；
 * - 主区域视图（view）与选中页面组成的路由持久化到 preferences.lastRoute，
 *   启动时恢复，覆盖 R001 的开始首页 / 最近 / 收藏 / 知识库首页 / 文档视图。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  AIConfig,
  Page,
  PageKind,
  PageTag,
  Preferences,
  SearchResult,
  Tag,
  Workspace,
} from "../domain/types";
import { DEFAULT_PREFERENCES } from "../domain/types";
import { searchPages } from "../domain/search";
import { parseRoute, serializeRoute, type AppRoute } from "../domain/route";
import type { WorkspaceSessionData } from "../application/services/WorkspaceSessionService";
import { PreferencesService } from "../application/services/PreferencesService";
import { useAppServices } from "./AppServicesProvider";

/** 知识库会话加载状态。 */
export type WorkspaceSessionStatus = "idle" | "loading" | "ready" | "error";

/** 知识库会话：四类数据必须同批次提交，由 reducer 保证原子性。 */
interface WorkspaceSessionState {
  status: WorkspaceSessionStatus;
  /** 最近一次加载请求的序号；过期响应据此丢弃。 */
  requestId: number;
  workspaceId: string | null;
  pages: Page[];
  tags: Tag[];
  pageTags: PageTag[];
  error: string | null;
}

type SessionAction =
  | { type: "session/load-start"; requestId: number; workspaceId: string }
  | { type: "session/load-success"; requestId: number; data: WorkspaceSessionData }
  | { type: "session/load-error"; requestId: number; error: string }
  | { type: "pages/set"; pages: Page[] | ((prev: Page[]) => Page[]) }
  | {
      type: "tags/set-all";
      tags: Tag[];
      pageTags: PageTag[];
    };

const initialSession: WorkspaceSessionState = {
  status: "idle",
  requestId: 0,
  workspaceId: null,
  pages: [],
  tags: [],
  pageTags: [],
  error: null,
};

function sessionReducer(
  state: WorkspaceSessionState,
  action: SessionAction,
): WorkspaceSessionState {
  switch (action.type) {
    case "session/load-start":
      // 加载期间清空旧数据：UI 要么看到 loading，要么看到完整新会话，绝不混合。
      return {
        status: "loading",
        requestId: action.requestId,
        workspaceId: action.workspaceId,
        pages: [],
        tags: [],
        pageTags: [],
        error: null,
      };
    case "session/load-success":
      // 过期响应直接丢弃：快速连切时只有最后一次请求生效。
      if (action.requestId !== state.requestId) return state;
      return {
        status: "ready",
        requestId: state.requestId,
        workspaceId: action.data.workspaceId,
        pages: action.data.pages,
        tags: action.data.tags,
        pageTags: action.data.pageTags,
        error: null,
      };
    case "session/load-error":
      if (action.requestId !== state.requestId) return state;
      return { ...state, status: "error", error: action.error };
    case "pages/set":
      return {
        ...state,
        pages:
          typeof action.pages === "function"
            ? action.pages(state.pages)
            : action.pages,
      };
    case "tags/set-all":
      // 标签与页面-标签关联同批次提交，避免 UI 读到只更新了一半的标签状态。
      return { ...state, tags: action.tags, pageTags: action.pageTags };
  }
}

/** 通过 useApp() 暴露给组件树的全部状态与动作。 */
interface AppState {
  /** 初始加载（含路由恢复）完成后置为 true；此前主区域应显示加载态。 */
  ready: boolean;
  /** 初始加载失败时的错误信息；为 null 表示正常。 */
  error: string | null;
  /** 全部知识库（含未选中的）。 */
  workspaces: Workspace[];
  /** 当前知识库；由内部 workspaceId 派生，未匹配时为 null。 */
  workspace: Workspace | null;
  /** 知识库会话状态：切换知识库期间为 loading，失败为 error（R003 阶段 2）。 */
  workspaceStatus: WorkspaceSessionStatus;
  /** 知识库会话加载失败的错误信息；为 null 表示正常。 */
  workspaceError: string | null;
  /** 当前知识库的页面镜像（含分组与回收站条目）。 */
  pages: Page[];
  /** 当前打开的文档 ID；仅 view === "document" 时有意义。 */
  selectedPageId: string | null;
  /** 主区域视图：开始首页 / 最近 / 收藏 / 知识库首页 / 文档编辑。 */
  view: MainView;
  /** 新建文档后需要聚焦标题的页面 ID（消费后清除）。 */
  titleFocusPageId: string | null;
  preferences: Preferences;
  /** 路由/偏好异步写入状态：失败时为 "error"（R003 阶段 3，错误可观测）。 */
  routePersistenceStatus: "idle" | "error";
  tags: Tag[];
  /** 当前工作区的全部页面-标签关联。 */
  pageTags: PageTag[];
  /** 回收站内的页面（派生自 pages）。 */
  trashedPages: Page[];
  /** 选中当前知识库内的文档并切到文档视图；传 null 仅清除选中，不切换视图。 */
  selectPage(id: string | null): void;
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
  /** 打开文档（可跨知识库，自动切换）。 */
  openDocument(pageId: string): Promise<void>;
  /** 定位文档：切换到所属知识库并在树中高亮，主区域显示知识库首页。 */
  locatePage(pageId: string): Promise<void>;
  /** 文档在主区域完成渲染后记录最近浏览时间。 */
  markOpened(pageId: string): Promise<void>;
  /** 切换文档收藏状态；可作用于其他知识库的页面（自动回退全量查询）。 */
  togglePageFavorite(pageId: string): Promise<void>;
  /** 切换知识库收藏状态。 */
  toggleWorkspaceFavorite(workspaceId: string): Promise<void>;
  /** 在指定知识库（可选分组下）新建文档并打开。 */
  createDocumentIn(workspaceId: string, parentId: string | null): Promise<Page>;
  /** 在当前知识库新建页面；文档会打开并请求标题聚焦，分组仅加入页面树。 */
  createPage(kind: PageKind, parentId: string | null): Promise<Page | null>;
  renamePage(id: string, title: string): Promise<void>;
  /** 软删页面（移入回收站）；若删除的是当前文档，主区域回到知识库首页。 */
  deletePage(id: string): Promise<void>;
  /** 移动页面到新父级的指定排序位置（parentId 为 null 表示顶层）。 */
  movePage(id: string, parentId: string | null, index: number): Promise<void>;
  /** 从回收站恢复页面。 */
  restorePage(id: string): Promise<void>;
  /** 彻底删除页面（含级联）；若是当前文档则回到知识库首页。 */
  purgePage(id: string): Promise<void>;
  /** 清空当前知识库的回收站。 */
  emptyTrash(): Promise<void>;
  /** 在当前知识库创建标签；未选中知识库时返回 null。 */
  createTag(name: string, color: string): Promise<Tag | null>;
  /** 删除标签并刷新页面-标签关联。 */
  deleteTag(id: string): Promise<void>;
  /** 覆盖式设置某页面的标签集合。 */
  setPageTags(pageId: string, tagIds: string[]): Promise<void>;
  /** 全局搜索：按标题与正文快照匹配当前工作区文档。 */
  search(query: string): Promise<SearchResult[]>;
  /** 初始加载失败后重试。 */
  retryLoad(): void;
  /** 创建知识库并立即切换过去。 */
  createWorkspace(
    name: string,
    extra?: { icon?: string | null; description?: string },
  ): Promise<void>;
  /** 切换当前知识库：原子重载其页面/标签/关联并进入知识库首页。 */
  switchWorkspace(id: string): Promise<void>;
  /** 更新主题偏好并持久化。 */
  setTheme(theme: Preferences["theme"]): Promise<void>;
  /** 更新侧栏宽度偏好并持久化。 */
  setSidebarWidth(width: number): Promise<void>;
  /** 保存或清除 AI 配置（传 null 清除）。 */
  setAIConfig(config: AIConfig | null): Promise<void>;
  /** 设置面板开关状态（SettingsPanel 与 AI 面板共用）。 */
  settingsOpen: boolean;
  openSettings(): void;
  closeSettings(): void;
}

// 默认 null：配合 useApp() 的守卫，让 Provider 外的误用在开发期直接抛错。
const AppContext = createContext<AppState | null>(null);

/** 主区域视图种类：与持久化路由 AppRoute.view 一一对应。 */
export type MainView = "start" | "recent" | "favorites" | "workspace" | "document";

/** 全局状态 Provider：挂载时加载知识库与偏好并恢复上次路由。 */
export function AppProvider({ children }: { children: ReactNode }) {
  // 应用能力一律来自服务容器（R003 阶段 5）：不再直接 import infrastructure。
  // 解构别名保持下文调用点不变；容器引用稳定（生产为单例），不影响 hook 依赖语义。
  const services = useAppServices();
  const {
    workspace: workspaceRepository,
    page: pageRepository,
    content: contentRepository,
    tag: tagRepository,
    preferences: preferencesRepository,
    session: sessionService,
  } = services;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadKey, setLoadKey] = useState(0);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [session, dispatchSession] = useReducer(sessionReducer, initialSession);
  // 会话加载请求序号：每次加载递增，过期响应据此丢弃（R003 阶段 2）。
  const sessionRequestRef = useRef(0);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [view, setView] = useState<MainView>("start");
  const [titleFocusPageId, setTitleFocusPageId] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 路由持久化状态（R003 阶段 3）：偏好异步写入错误可观测。
  const [routePersistenceStatus, setRoutePersistenceStatus] = useState<
    "idle" | "error"
  >("idle");
  // 偏好写入服务：串行合并主题/侧栏宽度/AI 配置/路由更新，杜绝读-改-写竞态。
  const preferencesService = useMemo(
    () =>
      new PreferencesService({
        preferences: preferencesRepository,
        onError: (err) => {
          console.error("偏好写入失败", err);
          setRoutePersistenceStatus("error");
        },
      }),
    [preferencesRepository],
  );

  const workspaceId = session.workspaceId;
  const pages = session.pages;
  const tags = session.tags;
  const pageTags = session.pageTags;

  /**
   * 原子加载知识库会话：数据一次拉齐、单次 dispatch 提交；
   * 返回数据供调用方继续流程（如路由恢复时校验文档存在性）；
   * 过期请求或加载失败返回 null，调用方应中止后续导航。
   */
  const loadSession = useCallback(
    async (wsId: string): Promise<WorkspaceSessionData | null> => {
      const requestId = ++sessionRequestRef.current;
      dispatchSession({ type: "session/load-start", requestId, workspaceId: wsId });
      try {
        const data = await sessionService.load(wsId);
        if (requestId !== sessionRequestRef.current) return null;
        dispatchSession({ type: "session/load-success", requestId, data });
        return data;
      } catch (err) {
        if (requestId !== sessionRequestRef.current) return null;
        console.error("知识库会话加载失败", err);
        dispatchSession({
          type: "session/load-error",
          requestId,
          error: "知识库加载失败，请重试。",
        });
        return null;
      }
    },
    [],
  );

  // 当前知识库内的增量刷新：只更新页面镜像，不触碰会话其余字段。
  const loadPages = useCallback(async (wsId: string) => {
    const list = await pageRepository.listByWorkspace(wsId);
    dispatchSession({ type: "pages/set", pages: list });
    return list;
  }, []);

  // 标签与页面-标签关联并行加载、同批次提交。
  const loadTags = useCallback(async (wsId: string) => {
    const [tagList, pageTagList] = await Promise.all([
      tagRepository.listByWorkspace(wsId),
      tagRepository.listWorkspacePageTags(wsId),
    ]);
    dispatchSession({ type: "tags/set-all", tags: tagList, pageTags: pageTagList });
  }, []);

  useEffect(() => {
    // StrictMode 双调用与 retryLoad 重试都会产生过期加载，用 cancelled 丢弃其结果。
    let cancelled = false;
    (async () => {
      try {
        setError(null);
        const [wsList, prefs] = await Promise.all([
          workspaceRepository.list(),
          preferencesRepository.get(),
        ]);
        if (cancelled) return;
        setWorkspaces(wsList);
        setPreferences(prefs);
        // 恢复上次路由；无记录（首次安装）或路由失效时回退开始首页。
        const route = parseRoute(prefs.lastRoute);
        const routeWs =
          route && (route.view === "workspace" || route.view === "document")
            ? (wsList.find((w) => w.id === route.workspaceId) ?? null)
            : null;
        const target = routeWs ?? wsList[0] ?? null;
        if (!target) {
          // 没有任何知识库：视为全新安装，直接就绪（UI 引导创建）。
          setReady(true);
          return;
        }
        const sessionData = await loadSession(target.id);
        if (cancelled || !sessionData) return;
        const pageList = sessionData.pages;
        let nextView: MainView = "start";
        let nextPageId: string | null = null;
        if (route?.view === "recent" || route?.view === "favorites") {
          nextView = route.view;
        } else if (routeWs && route?.view === "workspace") {
          nextView = "workspace";
        } else if (routeWs && route?.view === "document") {
          // 恢复文档视图前校验目标仍存在且未进回收站，防止打开已删除文档。
          const doc = pageList.find(
            (p) => p.id === route.pageId && p.kind === "document" && p.deletedAt === null,
          );
          if (doc) {
            nextView = "document";
            nextPageId = doc.id;
          } else {
            // 路由指向的文档已不存在：回到该知识库首页。
            nextView = "workspace";
          }
        }
        setView(nextView);
        setSelectedPageId(nextPageId);
        // 恢复的知识库记为最近使用。
        // fire-and-forget：不阻塞 ready，回写完成后再把 lastOpenedAt 合并进内存镜像。
        void workspaceRepository.setLastOpened(target.id, Date.now()).then(() => {
          setWorkspaces((prev) =>
            prev.map((w) => (w.id === target.id ? { ...w, lastOpenedAt: Date.now() } : w)),
          );
        });
        setReady(true);
      } catch {
        // 任何仓储异常统一降级为可重试的错误页，而不是让应用白屏。
        if (!cancelled) setError("本地数据加载失败，请重试。");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadSession, loadKey]);

  const workspace = workspaces.find((w) => w.id === workspaceId) ?? null;
  const trashedPages = pages.filter((p) => p.deletedAt !== null);

  const retryLoad = useCallback(() => {
    setReady(false);
    // loadKey 是初始加载 effect 的依赖，递增即触发整段加载重跑。
    setLoadKey((k) => k + 1);
  }, []);

  // 视图/页面切换时把路由写入 preferences，刷新后恢复到同一位置；
  // 经 PreferencesService 串行写入（last-write-wins），内存镜像同步更新。
  const persistRoute = useCallback(
    (route: AppRoute) => {
      const lastRoute = serializeRoute(route);
      preferencesService.persistRoute(lastRoute);
      setPreferences((prev) => ({ ...prev, lastRoute }));
    },
    [preferencesService],
  );

  const selectPage = useCallback(
    (id: string | null) => {
      setSelectedPageId(id);
      // 仅在确实选中页面时才切视图并持久化路由；传 null 只是清除选中。
      if (id && workspaceId) {
        setView("document");
        persistRoute({ view: "document", workspaceId, pageId: id });
      }
    },
    [workspaceId, persistRoute],
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
    if (!workspaceId) return;
    setView("workspace");
    persistRoute({ view: "workspace", workspaceId });
  }, [workspaceId, persistRoute]);

  const openDocument = useCallback(
    async (pageId: string) => {
      let wsId = workspaceId;
      const inState = pages.some((p) => p.id === pageId);
      let target = pages.find((p) => p.id === pageId);
      if (!target) {
        // 不在当前知识库镜像中（跨知识库打开）：回退全量查询定位。
        const all = await pageRepository.listAll();
        target = all.find((p) => p.id === pageId) ?? undefined;
      }
      if (!target || target.kind !== "document") return;
      if (target.workspaceId !== wsId) {
        // 跨知识库：原子加载目标库会话；未 ready 前不进入文档视图。
        wsId = target.workspaceId;
        const data = await loadSession(wsId);
        if (!data) return;
        void workspaceRepository.setLastOpened(wsId, Date.now());
      } else if (!inState && wsId) {
        // 页面由仓储直接创建（模板/AI 流程），当前列表未包含时同步刷新。
        await loadPages(wsId);
      }
      if (!wsId) return;
      setSelectedPageId(pageId);
      setView("document");
      persistRoute({ view: "document", workspaceId: wsId, pageId });
    },
    [workspaceId, pages, loadSession, loadPages, persistRoute],
  );

  const locatePage = useCallback(
    async (pageId: string) => {
      let wsId = workspaceId;
      let target = pages.find((p) => p.id === pageId);
      if (!target) {
        // 与 openDocument 相同：目标可能在其他知识库，回退全量查询。
        const all = await pageRepository.listAll();
        target = all.find((p) => p.id === pageId) ?? undefined;
      }
      if (!target) return;
      if (target.workspaceId !== wsId) {
        // 跨知识库定位：先原子加载所属知识库会话再在树中高亮。
        wsId = target.workspaceId;
        const data = await loadSession(wsId);
        if (!data) return;
        void workspaceRepository.setLastOpened(wsId, Date.now());
      }
      if (!wsId) return;
      // 与 openDocument 的区别：主区域停在知识库首页，由页面树高亮目标。
      setSelectedPageId(pageId);
      setView("workspace");
      persistRoute({ view: "workspace", workspaceId: wsId });
    },
    [workspaceId, pages, loadSession, persistRoute],
  );

  const markOpened = useCallback(async (pageId: string) => {
    const at = Date.now();
    await pageRepository.setLastOpened(pageId, at);
    dispatchSession({
      type: "pages/set",
      pages: (prev) =>
        prev.map((p) => (p.id === pageId ? { ...p, lastOpenedAt: at } : p)),
    });
  }, []);

  const togglePageFavorite = useCallback(
    async (pageId: string) => {
      // 收藏视图可跨知识库操作，目标页面不一定在当前镜像中，需回退全量查询。
      const page =
        pages.find((p) => p.id === pageId) ??
        (await pageRepository.listAll()).find((p) => p.id === pageId);
      if (!page) return;
      // favoriteAt 兼作排序依据：收藏时写入时间戳，取消时清空。
      const next = page.favoriteAt === null ? Date.now() : null;
      await pageRepository.setFavorite(pageId, next);
      dispatchSession({
        type: "pages/set",
        pages: (prev) =>
          prev.map((p) => (p.id === pageId ? { ...p, favoriteAt: next } : p)),
      });
    },
    [pages],
  );

  const toggleWorkspaceFavorite = useCallback(
    async (id: string) => {
      const ws = workspaces.find((w) => w.id === id);
      if (!ws) return;
      const next = ws.favoriteAt === null ? Date.now() : null;
      await workspaceRepository.setFavorite(id, next);
      setWorkspaces((prev) =>
        prev.map((w) => (w.id === id ? { ...w, favoriteAt: next } : w)),
      );
    },
    [workspaces],
  );

  const createDocumentIn = useCallback(
    async (wsId: string, parentId: string | null) => {
      const page = await pageRepository.create({
        workspaceId: wsId,
        parentId,
        kind: "document",
        title: "无标题",
      });
      if (wsId !== workspaceId) {
        // 在其他知识库中创建（如开始首页选择目标库）：原子切换会话上下文。
        const data = await loadSession(wsId);
        // 会话加载被更新的请求取代时中止导航，避免混入过期知识库。
        if (!data) return page;
      } else {
        await loadPages(wsId);
      }
      void workspaceRepository.setLastOpened(wsId, Date.now()).then(() => {
        setWorkspaces((prev) =>
          prev.map((w) => (w.id === wsId ? { ...w, lastOpenedAt: Date.now() } : w)),
        );
      });
      setSelectedPageId(page.id);
      // 新文档标题为空占位，请求 TitleEditor 自动聚焦便于立即改名。
      setTitleFocusPageId(page.id);
      setView("document");
      persistRoute({ view: "document", workspaceId: wsId, pageId: page.id });
      return page;
    },
    [workspaceId, loadSession, loadPages, persistRoute],
  );

  const createPage = useCallback(
    async (kind: PageKind, parentId: string | null) => {
      if (!workspaceId) return null;
      const page = await pageRepository.create({
        workspaceId,
        parentId,
        kind,
        title: kind === "group" ? "新建分组" : "无标题",
      });
      await loadPages(workspaceId);
      // 只有文档需要打开并聚焦标题；分组创建后停留在页面树中。
      if (kind === "document") {
        setSelectedPageId(page.id);
        setTitleFocusPageId(page.id);
        setView("document");
        persistRoute({ view: "document", workspaceId, pageId: page.id });
      }
      return page;
    },
    [workspaceId, loadPages, persistRoute],
  );

  const renamePage = useCallback(async (id: string, title: string) => {
    await pageRepository.rename(id, title);
    // 镜像中同步 updatedAt，让「最近编辑」排序立即反映本次重命名。
    dispatchSession({
      type: "pages/set",
      pages: (prev) =>
        prev.map((p) => (p.id === id ? { ...p, title, updatedAt: Date.now() } : p)),
    });
  }, []);

  const deletePage = useCallback(
    async (id: string) => {
      await pageRepository.remove(id);
      if (workspaceId) await loadPages(workspaceId);
      // 删除当前正在编辑的文档：主区域返回知识库首页。
      if (selectedPageId === id && workspaceId) {
        setSelectedPageId(null);
        setView("workspace");
        persistRoute({ view: "workspace", workspaceId });
      }
    },
    [workspaceId, selectedPageId, loadPages, persistRoute],
  );

  const movePage = useCallback(
    async (id: string, parentId: string | null, index: number) => {
      await pageRepository.move(id, parentId, index);
      if (workspaceId) await loadPages(workspaceId);
    },
    [workspaceId, loadPages],
  );

  const restorePage = useCallback(
    async (id: string) => {
      await pageRepository.restore(id);
      if (workspaceId) await loadPages(workspaceId);
    },
    [workspaceId, loadPages],
  );

  const purgePage = useCallback(
    async (id: string) => {
      await pageRepository.purge(id);
      if (workspaceId) await loadPages(workspaceId);
      // 与软删一致：彻底删除当前文档时主区域回到知识库首页。
      if (selectedPageId === id && workspaceId) {
        setSelectedPageId(null);
        setView("workspace");
        persistRoute({ view: "workspace", workspaceId });
      }
    },
    [workspaceId, selectedPageId, loadPages, persistRoute],
  );

  const emptyTrash = useCallback(async () => {
    if (!workspaceId) return;
    await pageRepository.purgeTrashed(workspaceId);
    await loadPages(workspaceId);
  }, [workspaceId, loadPages]);

  const createTag = useCallback(
    async (name: string, color: string) => {
      if (!workspaceId) return null;
      const tag = await tagRepository.create(workspaceId, name, color);
      await loadTags(workspaceId);
      return tag;
    },
    [workspaceId, loadTags],
  );

  const deleteTag = useCallback(
    async (id: string) => {
      await tagRepository.remove(id);
      if (workspaceId) await loadTags(workspaceId);
    },
    [workspaceId, loadTags],
  );

  const setPageTags = useCallback(
    async (pageId: string, tagIds: string[]) => {
      await tagRepository.setPageTags(pageId, tagIds);
      if (workspaceId) await loadTags(workspaceId);
    },
    [workspaceId, loadTags],
  );

  const search = useCallback(
    async (query: string) => {
      // 标题取内存镜像（含未落库的最新重命名），正文快照仍从仓储读取。
      const contents = await contentRepository.listAll();
      return searchPages(pages, contents, query);
    },
    [pages],
  );

  const createWorkspace = useCallback(
    async (name: string, extra?: { icon?: string | null; description?: string }) => {
      const ws = await workspaceRepository.create(name, extra);
      setWorkspaces((prev) => [...prev, ws]);
      // 原子加载新知识库会话；被更新的请求取代时中止导航。
      const data = await loadSession(ws.id);
      if (!data) return;
      setSelectedPageId(null);
      setView("workspace");
      persistRoute({ view: "workspace", workspaceId: ws.id });
      void workspaceRepository.setLastOpened(ws.id, Date.now()).then(() => {
        setWorkspaces((prev) =>
          prev.map((w) => (w.id === ws.id ? { ...w, lastOpenedAt: Date.now() } : w)),
        );
      });
    },
    [loadSession, persistRoute],
  );

  const switchWorkspace = useCallback(
    async (id: string) => {
      // 原子切换：会话数据同批次提交，过期请求在此被丢弃、中止导航。
      const data = await loadSession(id);
      if (!data) return;
      // 进入知识库首页，目录结构在侧栏与首页中呈现。
      setSelectedPageId(null);
      setView("workspace");
      persistRoute({ view: "workspace", workspaceId: id });
      void workspaceRepository.setLastOpened(id, Date.now()).then(() => {
        setWorkspaces((prev) =>
          prev.map((w) => (w.id === id ? { ...w, lastOpenedAt: Date.now() } : w)),
        );
      });
    },
    [loadSession, persistRoute],
  );

  // 偏好更新统一走 PreferencesService 串行队列（R003 阶段 3）：
  // update 返回合并后的完整偏好，直接整体替换内存镜像。
  const setTheme = useCallback(
    async (theme: Preferences["theme"]) => {
      const next = await preferencesService.update({ theme });
      setPreferences(next);
    },
    [preferencesService],
  );

  const setSidebarWidth = useCallback(
    async (width: number) => {
      // 拖动期间内存实时更新，持久化经服务 250ms 防抖（只落盘最后一次）。
      setPreferences((prev) => ({ ...prev, sidebarWidth: width }));
      preferencesService.updateSidebarWidthDebounced(width);
    },
    [preferencesService],
  );

  const setAIConfig = useCallback(
    async (config: AIConfig | null) => {
      const next = await preferencesService.update({ aiConfig: config });
      setPreferences(next);
    },
    [preferencesService],
  );

  const openSettings = useCallback(() => {
    setSettingsOpen(true);
  }, []);

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
  }, []);

  const value = useMemo<AppState>(
    () => ({
      ready,
      error,
      workspaces,
      workspace,
      workspaceStatus: session.status,
      workspaceError: session.error,
      pages,
      selectedPageId,
      view,
      titleFocusPageId,
      preferences,
      routePersistenceStatus,
      tags,
      pageTags,
      trashedPages,
      selectPage,
      showStart,
      showRecent,
      showFavorites,
      showWorkspaceHome,
      clearTitleFocus,
      openDocument,
      locatePage,
      markOpened,
      togglePageFavorite,
      toggleWorkspaceFavorite,
      createDocumentIn,
      createPage,
      renamePage,
      deletePage,
      movePage,
      restorePage,
      purgePage,
      emptyTrash,
      createTag,
      deleteTag,
      setPageTags,
      search,
      retryLoad,
      createWorkspace,
      switchWorkspace,
      setTheme,
      setSidebarWidth,
      setAIConfig,
      settingsOpen,
      openSettings,
      closeSettings,
    }),
    [
      ready,
      error,
      workspaces,
      workspace,
      session.status,
      session.error,
      pages,
      selectedPageId,
      view,
      titleFocusPageId,
      preferences,
      routePersistenceStatus,
      tags,
      pageTags,
      trashedPages,
      selectPage,
      showStart,
      showRecent,
      showFavorites,
      showWorkspaceHome,
      clearTitleFocus,
      openDocument,
      locatePage,
      markOpened,
      togglePageFavorite,
      toggleWorkspaceFavorite,
      createDocumentIn,
      createPage,
      renamePage,
      deletePage,
      movePage,
      restorePage,
      purgePage,
      emptyTrash,
      createTag,
      deleteTag,
      setPageTags,
      search,
      retryLoad,
      createWorkspace,
      switchWorkspace,
      setTheme,
      setSidebarWidth,
      setAIConfig,
      settingsOpen,
      openSettings,
      closeSettings,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

/** 读取全局状态；在 AppProvider 外调用直接抛错，尽早暴露用法错误。 */
export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp 必须在 AppProvider 内使用");
  return ctx;
}
