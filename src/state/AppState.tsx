/**
 * 应用全局状态层：UI 与基础设施之间的唯一桥梁。
 *
 * 架构位置：视图组件只通过 useApp() 读状态、触发动作；动作内部调用
 * src/infrastructure 的仓储接口写入 IndexedDB，再以 setState 同步内存镜像，
 * 因此仓储实现可整体替换而不影响 UI（docs/architecture.md 的分层约束）。
 *
 * 关键设计：
 * - pages / tags / workspaces 是 IndexedDB 的内存镜像：写操作先落库再刷新，
 *   保证刷新页面后状态可完整恢复；
 * - 主区域视图（view）与选中页面组成的路由持久化到 preferences.lastRoute，
 *   启动时恢复，覆盖 R001 的开始首页 / 最近 / 收藏 / 知识库首页 / 文档视图；
 * - 切换知识库时并行重载其页面与标签，并回写 lastOpenedAt 维护「最近使用」排序。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
import {
  contentRepository,
  pageRepository,
  preferencesRepository,
  tagRepository,
  workspaceRepository,
} from "../infrastructure/repositories";

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
  /** 当前知识库的页面镜像（含分组与回收站条目）。 */
  pages: Page[];
  /** 当前打开的文档 ID；仅 view === "document" 时有意义。 */
  selectedPageId: string | null;
  /** 主区域视图：开始首页 / 最近 / 收藏 / 知识库首页 / 文档编辑。 */
  view: MainView;
  /** 新建文档后需要聚焦标题的页面 ID（消费后清除）。 */
  titleFocusPageId: string | null;
  preferences: Preferences;
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
  /** 切换当前知识库：重载其页面/标签并进入知识库首页。 */
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
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadKey, setLoadKey] = useState(0);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [view, setView] = useState<MainView>("start");
  const [titleFocusPageId, setTitleFocusPageId] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [tags, setTags] = useState<Tag[]>([]);
  const [pageTags, setPageTagList] = useState<PageTag[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 从仓储重取页面并覆盖内存镜像；返回列表供调用方继续使用（如路由恢复时校验文档存在性）。
  const loadPages = useCallback(async (wsId: string) => {
    const list = await pageRepository.listByWorkspace(wsId);
    setPages(list);
    return list;
  }, []);

  // 标签与页面-标签关联并行加载、一起刷新，避免 UI 读到只更新了一半的标签状态。
  const loadTags = useCallback(async (wsId: string) => {
    const [tagList, pageTagList] = await Promise.all([
      tagRepository.listByWorkspace(wsId),
      tagRepository.listWorkspacePageTags(wsId),
    ]);
    setTags(tagList);
    setPageTagList(pageTagList);
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
        setWorkspaceId(target.id);
        const [pageList] = await Promise.all([
          loadPages(target.id),
          loadTags(target.id),
        ]);
        if (cancelled) return;
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
  }, [loadPages, loadTags, loadKey]);

  const workspace = workspaces.find((w) => w.id === workspaceId) ?? null;
  const trashedPages = pages.filter((p) => p.deletedAt !== null);

  const retryLoad = useCallback(() => {
    setReady(false);
    // loadKey 是初始加载 effect 的依赖，递增即触发整段加载重跑。
    setLoadKey((k) => k + 1);
  }, []);

  // 视图/页面切换时把路由写入 preferences，刷新后恢复到同一位置；
  // update 返回完整偏好，直接替换内存镜像保持一致。
  const persistRoute = useCallback((route: AppRoute) => {
    void preferencesRepository
      .update({ lastRoute: serializeRoute(route) })
      .then(setPreferences);
  }, []);

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
        // 跨知识库：切换上下文并重载目标库的页面与标签。
        wsId = target.workspaceId;
        setWorkspaceId(wsId);
        await Promise.all([loadPages(wsId), loadTags(wsId)]);
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
    [workspaceId, pages, loadPages, loadTags, persistRoute],
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
        // 跨知识库定位：先切换到所属知识库再在树中高亮。
        wsId = target.workspaceId;
        setWorkspaceId(wsId);
        await Promise.all([loadPages(wsId), loadTags(wsId)]);
        void workspaceRepository.setLastOpened(wsId, Date.now());
      }
      if (!wsId) return;
      // 与 openDocument 的区别：主区域停在知识库首页，由页面树高亮目标。
      setSelectedPageId(pageId);
      setView("workspace");
      persistRoute({ view: "workspace", workspaceId: wsId });
    },
    [workspaceId, pages, loadPages, loadTags, persistRoute],
  );

  const markOpened = useCallback(async (pageId: string) => {
    const at = Date.now();
    await pageRepository.setLastOpened(pageId, at);
    setPages((prev) =>
      prev.map((p) => (p.id === pageId ? { ...p, lastOpenedAt: at } : p)),
    );
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
      setPages((prev) =>
        prev.map((p) => (p.id === pageId ? { ...p, favoriteAt: next } : p)),
      );
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
        // 在其他知识库中创建（如开始首页选择目标库）：顺带切换上下文。
        setWorkspaceId(wsId);
        await Promise.all([loadPages(wsId), loadTags(wsId)]);
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
    [workspaceId, loadPages, loadTags, persistRoute],
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

  const renamePage = useCallback(
    async (id: string, title: string) => {
      await pageRepository.rename(id, title);
      // 镜像中同步 updatedAt，让「最近编辑」排序立即反映本次重命名。
      setPages((prev) =>
        prev.map((p) => (p.id === id ? { ...p, title, updatedAt: Date.now() } : p)),
      );
    },
    [],
  );

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
      setWorkspaceId(ws.id);
      setSelectedPageId(null);
      setView("workspace");
      persistRoute({ view: "workspace", workspaceId: ws.id });
      void workspaceRepository.setLastOpened(ws.id, Date.now()).then(() => {
        setWorkspaces((prev) =>
          prev.map((w) => (w.id === ws.id ? { ...w, lastOpenedAt: Date.now() } : w)),
        );
      });
      await Promise.all([loadPages(ws.id), loadTags(ws.id)]);
    },
    [loadPages, loadTags, persistRoute],
  );

  const switchWorkspace = useCallback(
    async (id: string) => {
      setWorkspaceId(id);
      await Promise.all([loadPages(id), loadTags(id)]);
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
    [loadPages, loadTags, persistRoute],
  );

  // preferencesRepository.update 返回更新后的完整偏好，直接整体替换内存镜像。
  const setTheme = useCallback(async (theme: Preferences["theme"]) => {
    const next = await preferencesRepository.update({ theme });
    setPreferences(next);
  }, []);

  const setSidebarWidth = useCallback(async (width: number) => {
    const next = await preferencesRepository.update({ sidebarWidth: width });
    setPreferences(next);
  }, []);

  const setAIConfig = useCallback(async (config: AIConfig | null) => {
    const next = await preferencesRepository.update({ aiConfig: config });
    setPreferences(next);
  }, []);

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
      pages,
      selectedPageId,
      view,
      titleFocusPageId,
      preferences,
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
      pages,
      selectedPageId,
      view,
      titleFocusPageId,
      preferences,
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

/** 供文档编辑器阶段使用：读取页面正文。 */
export { contentRepository };
