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
import { childrenOf } from "../domain/pageTree";
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
  preferences: Preferences;
  tags: Tag[];
  /** 当前工作区的全部页面-标签关联。 */
  pageTags: PageTag[];
  /** 回收站内的页面（派生自 pages）。 */
  trashedPages: Page[];
  selectPage(id: string | null): void;
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
  createWorkspace(name: string): Promise<void>;
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

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadKey, setLoadKey] = useState(0);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
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
        const first = wsList[0] ?? null;
        setWorkspaces(wsList);
        setPreferences(prefs);
        if (first) {
          setWorkspaceId(first.id);
          const [pageList] = await Promise.all([
            loadPages(first.id),
            loadTags(first.id),
          ]);
          if (cancelled) return;
          // getAll 按主键（随机 ID）返回，顺序不稳定；按页面树 position 取首篇文档。
          const firstDoc = childrenOf(pageList, null).find(
            (p) => p.kind === "document",
          );
          setSelectedPageId(firstDoc?.id ?? null);
        }
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

  const selectPage = useCallback((id: string | null) => {
    setSelectedPageId(id);
  }, []);

  const createPage = useCallback(
    async (kind: PageKind, parentId: string | null) => {
      if (!workspaceId) return null;
      const page = await pageRepository.create({
        workspaceId,
        parentId,
        kind,
        title: kind === "folder" ? "新建文件夹" : "无标题",
      });
      await loadPages(workspaceId);
      if (kind === "document") setSelectedPageId(page.id);
      return page;
    },
    [workspaceId, loadPages],
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
      setSelectedPageId((current) => (current === id ? null : current));
    },
    [workspaceId, loadPages],
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
      setSelectedPageId((current) => (current === id ? null : current));
    },
    [workspaceId, loadPages],
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

  const createWorkspace = useCallback(async (name: string) => {
    const ws = await workspaceRepository.create(name);
    setWorkspaces((prev) => [...prev, ws]);
    setWorkspaceId(ws.id);
    setSelectedPageId(null);
    await Promise.all([loadPages(ws.id), loadTags(ws.id)]);
  }, [loadPages, loadTags]);

  const switchWorkspace = useCallback(
    async (id: string) => {
      setWorkspaceId(id);
      const [list] = await Promise.all([loadPages(id), loadTags(id)]);
      const firstDoc = list.find((p) => p.kind === "document" && p.deletedAt === null);
      setSelectedPageId(firstDoc?.id ?? null);
    },
    [loadPages, loadTags],
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
      preferences,
      tags,
      pageTags,
      trashedPages,
      selectPage,
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
      preferences,
      tags,
      pageTags,
      trashedPages,
      selectPage,
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
