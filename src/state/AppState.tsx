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

interface AppState {
  ready: boolean;
  /** 初始加载失败时的错误信息；为 null 表示正常。 */
  error: string | null;
  workspaces: Workspace[];
  workspace: Workspace | null;
  pages: Page[];
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
  togglePageFavorite(pageId: string): Promise<void>;
  toggleWorkspaceFavorite(workspaceId: string): Promise<void>;
  /** 在指定知识库（可选分组下）新建文档并打开。 */
  createDocumentIn(workspaceId: string, parentId: string | null): Promise<Page>;
  createPage(kind: PageKind, parentId: string | null): Promise<Page | null>;
  renamePage(id: string, title: string): Promise<void>;
  deletePage(id: string): Promise<void>;
  movePage(id: string, parentId: string | null, index: number): Promise<void>;
  restorePage(id: string): Promise<void>;
  purgePage(id: string): Promise<void>;
  emptyTrash(): Promise<void>;
  createTag(name: string, color: string): Promise<Tag | null>;
  deleteTag(id: string): Promise<void>;
  setPageTags(pageId: string, tagIds: string[]): Promise<void>;
  /** 全局搜索：按标题与正文快照匹配当前工作区文档。 */
  search(query: string): Promise<SearchResult[]>;
  /** 初始加载失败后重试。 */
  retryLoad(): void;
  createWorkspace(
    name: string,
    extra?: { icon?: string | null; description?: string },
  ): Promise<void>;
  switchWorkspace(id: string): Promise<void>;
  setTheme(theme: Preferences["theme"]): Promise<void>;
  setSidebarWidth(width: number): Promise<void>;
  /** 保存或清除 AI 配置（传 null 清除）。 */
  setAIConfig(config: AIConfig | null): Promise<void>;
  /** 设置面板开关状态（SettingsPanel 与 AI 面板共用）。 */
  settingsOpen: boolean;
  openSettings(): void;
  closeSettings(): void;
}

const AppContext = createContext<AppState | null>(null);

/** 主区域视图种类。 */
export type MainView = "start" | "recent" | "favorites" | "workspace" | "document";

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

  const loadPages = useCallback(async (wsId: string) => {
    const list = await pageRepository.listByWorkspace(wsId);
    setPages(list);
    return list;
  }, []);

  const loadTags = useCallback(async (wsId: string) => {
    const [tagList, pageTagList] = await Promise.all([
      tagRepository.listByWorkspace(wsId),
      tagRepository.listWorkspacePageTags(wsId),
    ]);
    setTags(tagList);
    setPageTagList(pageTagList);
  }, []);

  useEffect(() => {
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
        void workspaceRepository.setLastOpened(target.id, Date.now()).then(() => {
          setWorkspaces((prev) =>
            prev.map((w) => (w.id === target.id ? { ...w, lastOpenedAt: Date.now() } : w)),
          );
        });
        setReady(true);
      } catch {
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
    setLoadKey((k) => k + 1);
  }, []);

  const persistRoute = useCallback((route: AppRoute) => {
    void preferencesRepository
      .update({ lastRoute: serializeRoute(route) })
      .then(setPreferences);
  }, []);

  const selectPage = useCallback(
    (id: string | null) => {
      setSelectedPageId(id);
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
        const all = await pageRepository.listAll();
        target = all.find((p) => p.id === pageId) ?? undefined;
      }
      if (!target || target.kind !== "document") return;
      if (target.workspaceId !== wsId) {
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
        const all = await pageRepository.listAll();
        target = all.find((p) => p.id === pageId) ?? undefined;
      }
      if (!target) return;
      if (target.workspaceId !== wsId) {
        wsId = target.workspaceId;
        setWorkspaceId(wsId);
        await Promise.all([loadPages(wsId), loadTags(wsId)]);
        void workspaceRepository.setLastOpened(wsId, Date.now());
      }
      if (!wsId) return;
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
      const page =
        pages.find((p) => p.id === pageId) ??
        (await pageRepository.listAll()).find((p) => p.id === pageId);
      if (!page) return;
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

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp 必须在 AppProvider 内使用");
  return ctx;
}

/** 供文档编辑器阶段使用：读取页面正文。 */
export { contentRepository };
