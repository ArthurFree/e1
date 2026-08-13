/**
 * 知识库会话生命周期控制器（PR4）：把原本堆在 WorkspaceProvider 里的
 * 业务生命周期（初始加载 + 路由恢复决策、会话加载的 requestId 过期保护、
 * 页面/标签镜像刷新、最近打开打点）下沉到 application 层。
 *
 * 分工：
 * - 控制器负责「做什么、按什么顺序、哪些响应过期」，不认识 React；
 * - 状态层（WorkspaceProvider）负责 useReducer/useState/Context 与导航桥，
 *   经 WorkspaceSessionSink 接收控制器的写回请求。
 *
 * fire-and-forget（最近打开打点）在本模块内联 catch 吞掉 rejection：
 * application 不得反向依赖 state 层的 ignoreRejection 工具。
 */
import { parseRoute, type AppRoute } from "../../domain/route";
import type { Page, PageTag, Tag, Workspace } from "../../domain/types";
import { trackTiming } from "../devDiagnostics";
import type { WorkspaceCommandService } from "../commands/WorkspaceCommandService";
import type { WorkspaceQueryService } from "../queries/WorkspaceQueryService";
import type { WorkspaceSessionData } from "./WorkspaceSessionService";

/**
 * 控制器对状态层的写回通道：由状态层实现（dispatch / setState 适配），
 * 成员必须引用稳定——控制器整会话只持有同一个 sink 实例。
 */
export interface WorkspaceSessionSink {
  /** 会话加载开始：清空旧数据并进入 loading。 */
  sessionLoadStarted(requestId: number, workspaceId: string): void;
  /** 会话加载成功：四类数据同批次提交。 */
  sessionLoadSucceeded(requestId: number, data: WorkspaceSessionData): void;
  /** 会话加载失败：置错误态（过期响应不会到达这里）。 */
  sessionLoadFailed(requestId: number, message: string): void;
  /** 页面镜像刷新（当前知识库内的增量刷新）。 */
  pagesLoaded(pages: Page[]): void;
  /** 标签与页面-标签关联同批次提交。 */
  tagsLoaded(tags: Tag[], pageTags: PageTag[]): void;
  /** 知识库列表镜像整体替换。 */
  workspacesLoaded(workspaces: Workspace[]): void;
  /** 最近打开打点落库成功后回填单个知识库的 lastOpenedAt。 */
  workspaceLastOpened(workspaceId: string, at: number): void;
}

export interface WorkspaceSessionControllerDeps {
  queries: WorkspaceQueryService;
  workspaceCommands: WorkspaceCommandService;
  sink: WorkspaceSessionSink;
  /** 当前会话所属知识库（refreshCurrentWorkspace 按需读取最新值）。 */
  getCurrentWorkspaceId(): string | null;
}

/**
 * 初始加载结果：状态层据此决定 ready / error / 导航恢复，
 * 不再自己编排「列表 → 偏好 → 会话 → 视图」的顺序。
 */
export type WorkspaceBootstrapResult =
  /** 没有任何知识库（全新安装）：直接就绪，由 UI 引导创建。 */
  | { status: "empty" }
  /** 请求已过期（卸载/重试）或会话加载被更新的请求取代：状态层不得继续。 */
  | { status: "aborted" }
  /** 仓储异常：降级为可重试的错误页。 */
  | { status: "failed"; message: string }
  /** 就绪：状态层据 view/pageId 经命令桥恢复导航。 */
  | {
      status: "restored";
      workspaceId: string;
      view: AppRoute["view"];
      pageId: string | null;
    };

/** 会话加载失败文案（原 WorkspaceProvider 内联文案）。 */
export const SESSION_LOAD_ERROR = "知识库加载失败，请重试。";
/** 初始加载失败文案（原 WorkspaceProvider 内联文案）。 */
export const INITIAL_LOAD_ERROR = "本地数据加载失败，请重试。";

export class WorkspaceSessionController {
  /** 会话加载请求序号：每次加载递增，过期响应据此丢弃（R003 阶段 2）。 */
  private requestSeq = 0;

  constructor(private readonly deps: WorkspaceSessionControllerDeps) {}

  /**
   * 原子加载知识库会话：数据一次拉齐、单次提交；返回数据供调用方继续
   * 流程（如路由恢复时校验文档存在性）；过期请求或加载失败返回 null，
   * 调用方应中止后续导航。搜索索引构建在查询服务内完成。
   */
  async loadSession(workspaceId: string): Promise<WorkspaceSessionData | null> {
    const requestId = ++this.requestSeq;
    this.deps.sink.sessionLoadStarted(requestId, workspaceId);
    try {
      const t0 = performance.now();
      const data = await this.deps.queries.loadSession(workspaceId);
      trackTiming("workspace-load", performance.now() - t0);
      if (requestId !== this.requestSeq) return null;
      this.deps.sink.sessionLoadSucceeded(requestId, data);
      return data;
    } catch (err) {
      if (requestId !== this.requestSeq) return null;
      console.error("知识库会话加载失败", err);
      this.deps.sink.sessionLoadFailed(requestId, SESSION_LOAD_ERROR);
      return null;
    }
  }

  /**
   * 当前知识库内的增量刷新：只更新页面镜像，不触碰会话其余字段；
   * 搜索索引同步在查询服务内完成。
   */
  async loadPages(workspaceId: string): Promise<Page[]> {
    const pages = await this.deps.queries.loadPages(workspaceId);
    this.deps.sink.pagesLoaded(pages);
    return pages;
  }

  /** 标签与页面-标签关联并行加载（查询服务内）、同批次提交。 */
  async loadTags(workspaceId: string): Promise<void> {
    const { tags, pageTags } = await this.deps.queries.loadTags(workspaceId);
    this.deps.sink.tagsLoaded(tags, pageTags);
  }

  /**
   * 刷新当前知识库的页面/标签镜像（R006-C3 FR-26）：重读页面、标签与
   * 页面-标签关联，供 Desktop「重新扫描知识库」在扫描缓存失效后刷新
   * 树与标签；无会话时为 no-op。
   */
  async refreshCurrentWorkspace(): Promise<void> {
    const workspaceId = this.deps.getCurrentWorkspaceId();
    if (!workspaceId) return;
    await Promise.all([this.loadPages(workspaceId), this.loadTags(workspaceId)]);
  }

  /**
   * 最近打开打点（fire-and-forget）：不阻塞导航，失败（含 IndexedDB
   * 连接 teardown）静默吞掉；落库成功且调用方仍存活时回填镜像。
   */
  touchLastOpened(
    workspaceId: string,
    at: number = Date.now(),
    isActive: () => boolean = () => true,
  ): void {
    void this.deps.workspaceCommands
      .setLastOpened(workspaceId, at)
      .then(() => {
        if (!isActive()) return;
        this.deps.sink.workspaceLastOpened(workspaceId, at);
      })
      .catch(() => {
        // 打点失败不影响任何用户可见流程，也不得产生未处理的 rejection。
      });
  }

  /**
   * 初始加载：知识库列表与偏好并行取数 → 决定目标知识库 → 原子加载会话
   * → 计算应恢复的视图。导航与 ready/error 的置位由状态层完成。
   *
   * @param input.preferences 偏好首次加载 Promise（PreferencesProvider 的
   *   同一份结果，避免二次读取）。
   * @param input.isActive 调用方存活判定：卸载或重试时返回 false，
   *   控制器据此在每个 await 后中止并停止写回。
   */
  async bootstrap(input: {
    preferences: Promise<{ lastRoute: string | null }>;
    isActive?: () => boolean;
  }): Promise<WorkspaceBootstrapResult> {
    const isActive = input.isActive ?? (() => true);
    try {
      const [workspaces, prefs] = await Promise.all([
        this.deps.queries.listWorkspaces(),
        input.preferences,
      ]);
      if (!isActive()) return { status: "aborted" };
      this.deps.sink.workspacesLoaded(workspaces);

      // 恢复上次路由；无记录（首次安装）或路由失效时回退开始首页。
      const route = parseRoute(prefs.lastRoute);
      const routeWorkspace =
        route && (route.view === "workspace" || route.view === "document")
          ? (workspaces.find((w) => w.id === route.workspaceId) ?? null)
          : null;
      const target = routeWorkspace ?? workspaces[0] ?? null;
      if (!target) return { status: "empty" };

      const data = await this.loadSession(target.id);
      if (!isActive() || !data) return { status: "aborted" };

      const restored = resolveRestoredView(route, routeWorkspace, data.pages);
      // 恢复的知识库记为最近使用；不阻塞就绪，卸载后不再写回。
      this.touchLastOpened(target.id, Date.now(), isActive);
      return {
        status: "restored",
        workspaceId: target.id,
        view: restored.view,
        pageId: restored.pageId,
      };
    } catch {
      // 任何仓储异常统一降级为可重试的错误页，而不是让应用白屏。
      return { status: "failed", message: INITIAL_LOAD_ERROR };
    }
  }
}

/**
 * 由持久化路由与会话页面推导应恢复的视图：文档视图需校验目标仍存在
 * 且未进回收站，防止打开已删除文档（失效时回退该知识库首页）。
 */
function resolveRestoredView(
  route: AppRoute | null,
  routeWorkspace: Workspace | null,
  pages: Page[],
): { view: AppRoute["view"]; pageId: string | null } {
  if (route?.view === "recent" || route?.view === "favorites") {
    return { view: route.view, pageId: null };
  }
  if (routeWorkspace && route?.view === "workspace") {
    return { view: "workspace", pageId: null };
  }
  if (routeWorkspace && route?.view === "document") {
    const doc = pages.find(
      (p) =>
        p.id === route.pageId && p.kind === "document" && p.deletedAt === null,
    );
    // 路由指向的文档已不存在：回到该知识库首页。
    return doc
      ? { view: "document", pageId: doc.id }
      : { view: "workspace", pageId: null };
  }
  return { view: "start", pageId: null };
}
