/**
 * 知识库状态 Provider（R004 阶段 4）：workspaces / 会话
 * （workspaceId/pages/tags/pageTags/status/error）与初始加载的所有者，
 * 负责切换知识库、页面与标签 CRUD、搜索索引构建。
 *
 * - R005 批次 1：业务编排下沉到 application 层命令/查询服务
 *   （services.commands / services.queries），本文件只保留 useReducer、
 *   requestId 过期保护、dispatch、navBridge 调用与错误展示；
 * - 会话数据由 useReducer 持有，原子加载与过期响应丢弃见
 *   workspace/sessionReducer.ts（R003 阶段 2）；
 * - pages / tags / workspaces 是 IndexedDB 的内存镜像：写操作先落库再刷新；
 * - 跨域动作（切换知识库后导航、新建文档后打开等）经 navigationBridge
 *   调用导航域命令，不复制导航逻辑；
 * - 导航域所需的会话能力（loadSession/loadPages/会话快照）经内部通道
 *   WorkspaceInternalsContext 暴露，公开 value 形状不变；
 * - 公开 Context 细分为数据/命令两片（R004 §4.6）：命令回调全部经 ref
 *   读取最新数据（sessionRef/workspacesRef），引用恒定，数据变化不会
 *   引起纯命令消费者重渲染。
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
import type { Page, PageKind, Workspace } from "../domain/types";
import { parseRoute } from "../domain/route";
import type { WorkspaceSessionData } from "../application/services/WorkspaceSessionService";
import { trackTiming } from "../application/devDiagnostics";
import {
  VaultImportService,
  type VaultImportReport,
} from "../application/vault/VaultImportService";
import { useAppServices } from "./AppServicesProvider";
import {
  WorkspaceCommandContext,
  WorkspaceDataContext,
  type WorkspaceCommandContextValue,
  type WorkspaceDataContextValue,
} from "./WorkspaceSessionContext";
import { initialSession, sessionReducer } from "./workspace/sessionReducer";
import { usePreferencesRoute } from "./PreferencesProvider";
import type { NavigationBridge } from "./navigationBridge";
import type { MainView } from "./NavigationContext";

/** 导航域内部通道（非公开契约）：会话加载与当前会话快照。 */
export interface WorkspaceInternalsContextValue {
  /**
   * 原子加载知识库会话：数据一次拉齐、单次 dispatch 提交；
   * 返回数据供调用方继续流程；过期请求或加载失败返回 null，调用方应中止。
   */
  loadSession(wsId: string): Promise<WorkspaceSessionData | null>;
  /** 当前知识库内的增量刷新：只更新页面镜像并同步搜索索引。 */
  loadPages(wsId: string): Promise<Page[]>;
  /** 当前会话快照（workspaceId/pages），供跨库动作定位目标页面。 */
  getSnapshot(): { workspaceId: string | null; pages: Page[] };
}

const WorkspaceInternalsContext =
  createContext<WorkspaceInternalsContextValue | null>(null);

/** 读取工作区内部通道；仅供 state 层内的 Provider 使用。 */
export function useWorkspaceInternals(): WorkspaceInternalsContextValue {
  const ctx = useContext(WorkspaceInternalsContext);
  if (!ctx) {
    throw new Error("useWorkspaceInternals 必须在 WorkspaceProvider 内使用");
  }
  return ctx;
}

interface WorkspaceProviderProps {
  /** 导航命令桥：跨域动作的导航部分经此调用（AppProviders 创建）。 */
  navBridge: NavigationBridge;
  children: ReactNode;
}

/** 知识库状态 Provider：挂载时加载知识库并恢复上次路由。 */
export function WorkspaceProvider({
  navBridge,
  children,
}: WorkspaceProviderProps) {
  // 应用能力一律来自服务容器（R003 阶段 5）：不再直接 import infrastructure。
  // R005 批次 1：仓储写/读编排改经命令/查询服务，原始仓储不再在此解构。
  const services = useAppServices();
  const workspaceCommands = services.commands.workspace;
  const pageCommands = services.commands.page;
  const tagCommands = services.commands.tag;
  const documentCommands = services.commands.document;
  const workspaceQueries = services.queries.workspace;
  const searchQueries = services.queries.search;
  const { syncChannel } = services;
  const { whenLoaded } = usePreferencesRoute();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadKey, setLoadKey] = useState(0);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [session, dispatchSession] = useReducer(sessionReducer, initialSession);
  // 会话加载请求序号：每次加载递增，过期响应据此丢弃（R003 阶段 2）。
  const sessionRequestRef = useRef(0);
  // 会话快照镜像：命令回调与 getSnapshot 经 ref 读取最新状态，保持引用稳定。
  const sessionRef = useRef(session);
  sessionRef.current = session;
  // workspaces 镜像：命令回调经 ref 读取最新列表，保持引用稳定（R004 §4.6）。
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;

  const workspaceId = session.workspaceId;
  const pages = session.pages;
  const tags = session.tags;
  const pageTags = session.pageTags;

  /**
   * 原子加载知识库会话：数据一次拉齐、单次 dispatch 提交；
   * 返回数据供调用方继续流程（如路由恢复时校验文档存在性）；
   * 过期请求或加载失败返回 null，调用方应中止后续导航。
   * 搜索索引构建在查询服务内完成（R005 批次 1）。
   */
  const loadSession = useCallback(
    async (wsId: string): Promise<WorkspaceSessionData | null> => {
      const requestId = ++sessionRequestRef.current;
      dispatchSession({
        type: "session/load-start",
        requestId,
        workspaceId: wsId,
      });
      try {
        const t0 = performance.now();
        const data = await workspaceQueries.loadSession(wsId);
        trackTiming("workspace-load", performance.now() - t0);
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
    [workspaceQueries],
  );

  // 当前知识库内的增量刷新：只更新页面镜像，不触碰会话其余字段；
  // 搜索索引同步在查询服务内完成（R005 批次 1）。
  const loadPages = useCallback(
    async (wsId: string) => {
      const list = await workspaceQueries.loadPages(wsId);
      dispatchSession({ type: "pages/set", pages: list });
      return list;
    },
    [workspaceQueries],
  );

  const getSnapshot = useCallback(
    () => ({
      workspaceId: sessionRef.current.workspaceId,
      pages: sessionRef.current.pages,
    }),
    [],
  );

  // 标签与页面-标签关联并行加载（查询服务内）、同批次提交。
  const loadTags = useCallback(
    async (wsId: string) => {
      const { tags: tagList, pageTags: pageTagList } =
        await workspaceQueries.loadTags(wsId);
      dispatchSession({
        type: "tags/set-all",
        tags: tagList,
        pageTags: pageTagList,
      });
    },
    [workspaceQueries],
  );

  useEffect(() => {
    // StrictMode 双调用与 retryLoad 重试都会产生过期加载，用 cancelled 丢弃其结果。
    let cancelled = false;
    (async () => {
      try {
        setError(null);
        // 偏好经 PreferencesProvider 的首次加载 Promise 就位（同一份结果）。
        const [wsList, prefs] = await Promise.all([
          workspaceQueries.listWorkspaces(),
          whenLoaded,
        ]);
        if (cancelled) return;
        setWorkspaces(wsList);
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
            (p) =>
              p.id === route.pageId &&
              p.kind === "document" &&
              p.deletedAt === null,
          );
          if (doc) {
            nextView = "document";
            nextPageId = doc.id;
          } else {
            // 路由指向的文档已不存在：回到该知识库首页。
            nextView = "workspace";
          }
        }
        // 导航状态由 NavigationProvider 持有，经命令桥恢复（不写回路由）。
        navBridge.commands?.restoreRoute(nextView, nextPageId);
        // 恢复的知识库记为最近使用。
        // fire-and-forget：不阻塞 ready，回写完成后再把 lastOpenedAt 合并进内存镜像。
        void workspaceCommands.setLastOpened(target.id, Date.now()).then(() => {
          setWorkspaces((prev) =>
            prev.map((w) =>
              w.id === target.id ? { ...w, lastOpenedAt: Date.now() } : w,
            ),
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
  }, [
    loadSession,
    loadKey,
    whenLoaded,
    navBridge,
    workspaceQueries,
    workspaceCommands,
  ]);

  const workspace = workspaces.find((w) => w.id === workspaceId) ?? null;

  const retryLoad = useCallback(() => {
    setReady(false);
    // loadKey 是初始加载 effect 的依赖，递增即触发整段加载重跑。
    setLoadKey((k) => k + 1);
  }, []);

  // —— 以下命令回调统一经 sessionRef/workspacesRef 读取最新数据，
  //    依赖只剩稳定引用（命令/查询服务/桥），回调身份恒定（R004 §4.6）——

  const togglePageFavorite = useCallback(
    async (pageId: string) => {
      // 收藏视图可跨知识库操作，目标页面不一定在当前镜像中，需回退全量查询。
      const page =
        sessionRef.current.pages.find((p) => p.id === pageId) ??
        (await workspaceQueries.findPage(pageId));
      if (!page) return;
      // favoriteAt 兼作排序依据：收藏时写入时间戳，取消时清空。
      const next = page.favoriteAt === null ? Date.now() : null;
      await pageCommands.toggleFavorite(pageId, next);
      dispatchSession({
        type: "pages/set",
        pages: (prev) =>
          prev.map((p) => (p.id === pageId ? { ...p, favoriteAt: next } : p)),
      });
    },
    [workspaceQueries, pageCommands],
  );

  const toggleWorkspaceFavorite = useCallback(
    async (id: string) => {
      const ws = workspacesRef.current.find((w) => w.id === id);
      if (!ws) return;
      const next = ws.favoriteAt === null ? Date.now() : null;
      await workspaceCommands.toggleFavorite(id, next);
      setWorkspaces((prev) =>
        prev.map((w) => (w.id === id ? { ...w, favoriteAt: next } : w)),
      );
    },
    [workspaceCommands],
  );

  const createDocumentIn = useCallback(
    async (wsId: string, parentId: string | null) => {
      const page = await pageCommands.create({
        workspaceId: wsId,
        parentId,
        kind: "document",
        title: "无标题",
      });
      if (wsId !== sessionRef.current.workspaceId) {
        // 在其他知识库中创建（如开始首页选择目标库）：原子切换会话上下文。
        const data = await loadSession(wsId);
        // 会话加载被更新的请求取代时中止导航，避免混入过期知识库。
        if (!data) return page;
      } else {
        await loadPages(wsId);
      }
      void workspaceCommands.setLastOpened(wsId, Date.now()).then(() => {
        setWorkspaces((prev) =>
          prev.map((w) =>
            w.id === wsId ? { ...w, lastOpenedAt: Date.now() } : w,
          ),
        );
      });
      // 新文档标题为空占位，请求 TitleEditor 自动聚焦便于立即改名。
      navBridge.commands?.openDocumentView(wsId, page.id, true);
      return page;
    },
    [loadSession, loadPages, navBridge, pageCommands, workspaceCommands],
  );

  const createPage = useCallback(
    async (kind: PageKind, parentId: string | null) => {
      const workspaceId = sessionRef.current.workspaceId;
      if (!workspaceId) return null;
      const page = await pageCommands.create({
        workspaceId,
        parentId,
        kind,
        title: kind === "group" ? "新建分组" : "无标题",
      });
      await loadPages(workspaceId);
      // 只有文档需要打开并聚焦标题；分组创建后停留在页面树中。
      if (kind === "document") {
        navBridge.commands?.openDocumentView(workspaceId, page.id, true);
      }
      return page;
    },
    [loadPages, navBridge, pageCommands],
  );

  // 原子创建「页面 + 初始正文」（R004）：模板/AI 草稿/Markdown 导入不再
  // 先建空页再写正文；写入与搜索索引同步在 DocumentCommitService 单点完成，
  // 跨标签页广播在文档命令服务内完成（R005 批次 1）。
  const createDocumentWithContent = useCallback(
    async (input: {
      workspaceId: string;
      parentId: string | null;
      title: string;
      contentJson: unknown;
      textSnapshot: string;
    }) => {
      const page = await documentCommands.createWithContent(input);
      // 属于当前知识库时全量刷新页面镜像（与 createPage 同一刷新方式）。
      if (input.workspaceId === sessionRef.current.workspaceId) {
        await loadPages(input.workspaceId);
      }
      return page;
    },
    [loadPages, documentCommands],
  );

  const renamePage = useCallback(
    async (id: string, title: string) => {
      const now = Date.now();
      // 页面在当前镜像中时合并出最新 page，命令服务据此同步搜索索引并广播
      // （对应原 current 查找逻辑）；不在镜像中时传 null 跳过索引与广播。
      const current = sessionRef.current.pages.find((p) => p.id === id);
      const updatedPage = current
        ? { ...current, title, updatedAt: now }
        : null;
      await pageCommands.rename(id, title, updatedPage);
      // 镜像中同步 updatedAt，让「最近编辑」排序立即反映本次重命名。
      dispatchSession({
        type: "pages/set",
        pages: (prev) =>
          prev.map((p) => (p.id === id ? { ...p, title, updatedAt: now } : p)),
      });
    },
    [pageCommands],
  );

  const deletePage = useCallback(
    async (id: string) => {
      const workspaceId = sessionRef.current.workspaceId;
      await pageCommands.remove(id, workspaceId);
      if (workspaceId) await loadPages(workspaceId);
      // 删除当前正在编辑的文档：主区域返回知识库首页。
      if (workspaceId)
        navBridge.commands?.exitDocumentIfSelected(id, workspaceId);
    },
    [loadPages, navBridge, pageCommands],
  );

  const movePage = useCallback(
    async (id: string, parentId: string | null, index: number) => {
      const workspaceId = sessionRef.current.workspaceId;
      await pageCommands.move(id, parentId, index, workspaceId);
      if (workspaceId) await loadPages(workspaceId);
    },
    [loadPages, pageCommands],
  );

  const restorePage = useCallback(
    async (id: string) => {
      const workspaceId = sessionRef.current.workspaceId;
      await pageCommands.restore(id, workspaceId);
      if (workspaceId) await loadPages(workspaceId);
    },
    [loadPages, pageCommands],
  );

  const purgePage = useCallback(
    async (id: string) => {
      const workspaceId = sessionRef.current.workspaceId;
      await pageCommands.purge(id, workspaceId);
      if (workspaceId) await loadPages(workspaceId);
      // 与软删一致：彻底删除当前文档时主区域回到知识库首页。
      if (workspaceId)
        navBridge.commands?.exitDocumentIfSelected(id, workspaceId);
    },
    [loadPages, navBridge, pageCommands],
  );

  const emptyTrash = useCallback(async () => {
    const workspaceId = sessionRef.current.workspaceId;
    if (!workspaceId) return;
    await pageCommands.purgeTrashed(workspaceId);
    await loadPages(workspaceId);
  }, [loadPages, pageCommands]);

  const createTag = useCallback(
    async (name: string, color: string) => {
      const workspaceId = sessionRef.current.workspaceId;
      if (!workspaceId) return null;
      const tag = await tagCommands.create(workspaceId, name, color);
      await loadTags(workspaceId);
      return tag;
    },
    [loadTags, tagCommands],
  );

  const deleteTag = useCallback(
    async (id: string) => {
      const workspaceId = sessionRef.current.workspaceId;
      await tagCommands.remove(id);
      if (workspaceId) await loadTags(workspaceId);
    },
    [loadTags, tagCommands],
  );

  const setPageTags = useCallback(
    async (pageId: string, tagIds: string[]) => {
      const workspaceId = sessionRef.current.workspaceId;
      await tagCommands.setPageTags(pageId, tagIds);
      if (workspaceId) await loadTags(workspaceId);
    },
    [loadTags, tagCommands],
  );

  const markOpened = useCallback(
    async (pageId: string) => {
      const at = Date.now();
      await pageCommands.setLastOpened(pageId, at);
      dispatchSession({
        type: "pages/set",
        pages: (prev) =>
          prev.map((p) => (p.id === pageId ? { ...p, lastOpenedAt: at } : p)),
      });
    },
    [pageCommands],
  );

  const search = useCallback(
    async (query: string) => {
      const { workspaceId, pages } = sessionRef.current;
      // 索引/全量回退双路径在查询服务内（R005 批次 1）。
      return searchQueries.query(workspaceId, pages, query);
    },
    [searchQueries],
  );

  const createWorkspace = useCallback(
    async (
      name: string,
      extra?: { icon?: string | null; description?: string },
    ) => {
      const ws = await workspaceCommands.create(name, extra);
      setWorkspaces((prev) => [...prev, ws]);
      // 原子加载新知识库会话；被更新的请求取代时中止导航。
      const data = await loadSession(ws.id);
      if (!data) return;
      navBridge.commands?.showWorkspaceHome(ws.id);
      void workspaceCommands.setLastOpened(ws.id, Date.now()).then(() => {
        setWorkspaces((prev) =>
          prev.map((w) =>
            w.id === ws.id ? { ...w, lastOpenedAt: Date.now() } : w,
          ),
        );
      });
    },
    [loadSession, navBridge, workspaceCommands],
  );

  // 导入 Portable Vault（R005 阶段 7B）：编排下沉到 application 层服务，
  // 这里只负责导入后的状态生命周期——知识库列表镜像刷新（新知识库由
  // 导入服务直接落库，不经 createWorkspace，故镜像整体重取）+ 切换到
  // 新知识库首页（与 createWorkspace 同一套 loadSession/navBridge 通道）。
  const importVault = useCallback(
    async (data: Uint8Array): Promise<VaultImportReport> => {
      const service = new VaultImportService({
        workspaceQuery: workspaceQueries,
        workspaceCommands,
        pageCommands,
        documentCommands,
        tagCommands,
        assetCommands: services.assets.commands,
      });
      const report = await service.importVault(data);
      setWorkspaces(await workspaceQueries.listWorkspaces());
      // 原子加载新知识库会话；被更新的请求取代时中止导航。
      const sessionData = await loadSession(report.workspaceId);
      if (!sessionData) return report;
      navBridge.commands?.showWorkspaceHome(report.workspaceId);
      void workspaceCommands
        .setLastOpened(report.workspaceId, Date.now())
        .then(() => {
          setWorkspaces((prev) =>
            prev.map((w) =>
              w.id === report.workspaceId
                ? { ...w, lastOpenedAt: Date.now() }
                : w,
            ),
          );
        });
      return report;
    },
    [
      workspaceQueries,
      workspaceCommands,
      pageCommands,
      documentCommands,
      tagCommands,
      services,
      loadSession,
      navBridge,
    ],
  );

  const switchWorkspace = useCallback(
    async (id: string) => {
      // 原子切换：会话数据同批次提交，过期请求在此被丢弃、中止导航。
      const data = await loadSession(id);
      if (!data) return;
      // 进入知识库首页，目录结构在侧栏与首页中呈现。
      navBridge.commands?.showWorkspaceHome(id);
      void workspaceCommands.setLastOpened(id, Date.now()).then(() => {
        setWorkspaces((prev) =>
          prev.map((w) =>
            w.id === id ? { ...w, lastOpenedAt: Date.now() } : w,
          ),
        );
      });
      // 「我切换了知识库」的跨标签页通知属于会话层编排，留在状态层发送。
      syncChannel.publish({ type: "workspace-changed", workspaceId: id });
    },
    [loadSession, navBridge, workspaceCommands, syncChannel],
  );

  // 其他标签页的页面/工作区变更（R004 §7.2）：属于当前会话工作区时
  // 增量刷新页面镜像（搜索索引随 loadPages 同步）；自己发出的动作不回声，
  // 接收路径（loadPages）不产生新事件，不会形成广播循环。
  useEffect(() => {
    return syncChannel.subscribe((event) => {
      if (event.type !== "page-changed" && event.type !== "workspace-changed") {
        return;
      }
      if (event.workspaceId !== sessionRef.current.workspaceId) return;
      void loadPages(event.workspaceId).catch(() => {
        // 刷新失败不改变本地镜像；下次动作或手动重试可恢复。
      });
    });
  }, [syncChannel, loadPages]);

  // —— 公开 value 细分为数据/命令两片（R004 §4.6，聚合形状不变）——

  const dataValue = useMemo<WorkspaceDataContextValue>(
    () => ({
      ready,
      error,
      workspaces,
      workspace,
      workspaceStatus: session.status,
      workspaceError: session.error,
      pages,
      tags,
      pageTags,
    }),
    [
      ready,
      error,
      workspaces,
      workspace,
      session.status,
      session.error,
      pages,
      tags,
      pageTags,
    ],
  );

  // 命令成员全部引用稳定（经 ref 读取最新数据），本 value 恒定：
  // 页面/标签/会话变化不会引起纯命令消费者重渲染。
  const commandValue = useMemo<WorkspaceCommandContextValue>(
    () => ({
      retryLoad,
      switchWorkspace,
      createWorkspace,
      importVault,
      toggleWorkspaceFavorite,
      createDocumentIn,
      createPage,
      createDocumentWithContent,
      renamePage,
      deletePage,
      movePage,
      restorePage,
      purgePage,
      emptyTrash,
      createTag,
      deleteTag,
      setPageTags,
      togglePageFavorite,
      markOpened,
      search,
    }),
    [
      retryLoad,
      switchWorkspace,
      createWorkspace,
      importVault,
      toggleWorkspaceFavorite,
      createDocumentIn,
      createPage,
      createDocumentWithContent,
      renamePage,
      deletePage,
      movePage,
      restorePage,
      purgePage,
      emptyTrash,
      createTag,
      deleteTag,
      setPageTags,
      togglePageFavorite,
      markOpened,
      search,
    ],
  );

  // 内部通道成员全部引用稳定：导航域不会因页面/标签变化而重渲染。
  const internalsValue = useMemo<WorkspaceInternalsContextValue>(
    () => ({ loadSession, loadPages, getSnapshot }),
    [loadSession, loadPages, getSnapshot],
  );

  return (
    <WorkspaceInternalsContext.Provider value={internalsValue}>
      <WorkspaceDataContext.Provider value={dataValue}>
        <WorkspaceCommandContext.Provider value={commandValue}>
          {children}
        </WorkspaceCommandContext.Provider>
      </WorkspaceDataContext.Provider>
    </WorkspaceInternalsContext.Provider>
  );
}
