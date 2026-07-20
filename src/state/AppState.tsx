import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Page, PageKind, Preferences, Workspace } from "../domain/types";
import { DEFAULT_PREFERENCES } from "../domain/types";
import {
  contentRepository,
  pageRepository,
  preferencesRepository,
  workspaceRepository,
} from "../infrastructure/repositories";

interface AppState {
  ready: boolean;
  workspaces: Workspace[];
  workspace: Workspace | null;
  pages: Page[];
  selectedPageId: string | null;
  preferences: Preferences;
  selectPage(id: string | null): void;
  createPage(kind: PageKind, parentId: string | null): Promise<Page | null>;
  renamePage(id: string, title: string): Promise<void>;
  deletePage(id: string): Promise<void>;
  createWorkspace(name: string): Promise<void>;
  switchWorkspace(id: string): Promise<void>;
  setTheme(theme: Preferences["theme"]): Promise<void>;
  setSidebarWidth(width: number): Promise<void>;
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);

  const loadPages = useCallback(async (wsId: string) => {
    const list = await pageRepository.listByWorkspace(wsId);
    setPages(list);
    return list;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
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
        const pageList = await loadPages(first.id);
        if (cancelled) return;
        const firstDoc = pageList.find(
          (p) => p.kind === "document" && p.deletedAt === null,
        );
        setSelectedPageId(firstDoc?.id ?? null);
      }
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadPages]);

  const workspace = workspaces.find((w) => w.id === workspaceId) ?? null;

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

  const createWorkspace = useCallback(async (name: string) => {
    const ws = await workspaceRepository.create(name);
    setWorkspaces((prev) => [...prev, ws]);
    setWorkspaceId(ws.id);
    setSelectedPageId(null);
    await loadPages(ws.id);
  }, [loadPages]);

  const switchWorkspace = useCallback(
    async (id: string) => {
      setWorkspaceId(id);
      const list = await loadPages(id);
      const firstDoc = list.find((p) => p.kind === "document" && p.deletedAt === null);
      setSelectedPageId(firstDoc?.id ?? null);
    },
    [loadPages],
  );

  const setTheme = useCallback(async (theme: Preferences["theme"]) => {
    const next = await preferencesRepository.update({ theme });
    setPreferences(next);
  }, []);

  const setSidebarWidth = useCallback(async (width: number) => {
    const next = await preferencesRepository.update({ sidebarWidth: width });
    setPreferences(next);
  }, []);

  const value = useMemo<AppState>(
    () => ({
      ready,
      workspaces,
      workspace,
      pages,
      selectedPageId,
      preferences,
      selectPage,
      createPage,
      renamePage,
      deletePage,
      createWorkspace,
      switchWorkspace,
      setTheme,
      setSidebarWidth,
    }),
    [
      ready,
      workspaces,
      workspace,
      pages,
      selectedPageId,
      preferences,
      selectPage,
      createPage,
      renamePage,
      deletePage,
      createWorkspace,
      switchWorkspace,
      setTheme,
      setSidebarWidth,
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
