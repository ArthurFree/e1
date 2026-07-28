/**
 * 兼容聚合门面（R003 阶段 6 引入，R004 阶段 4 迁入 legacy）：
 * 读取四个窄 Context 并聚合为原 AppState 全集，仅供未迁移的既有测试
 * 过渡使用。生产代码一律使用 useWorkspaceSession / useNavigation /
 * usePreferences / useOverlay 窄 hook 以获得渲染隔离。
 */
import { useContext, useMemo } from "react";
import type {
  AIConfig,
  Page,
  PageKind,
  PageTag,
  Preferences,
  SearchResult,
  Tag,
  Workspace,
} from "../../domain/types";
import {
  WorkspaceSessionContext,
  type WorkspaceSessionStatus,
} from "../WorkspaceSessionContext";
import {
  NavigationContext,
  type MainView,
} from "../NavigationContext";
import { PreferencesContext } from "../PreferencesContext";
import { useOverlay } from "../OverlayContext";

/** 通过 useApp() 暴露给组件树的全部状态与动作。 */
export interface AppState {
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
  /**
   * 原子创建「页面 + 初始正文」（R004：模板/AI 草稿/Markdown 导入）：
   * 经 DocumentCommitService 单事务落盘并同步搜索索引，失败抛错由调用方处理。
   */
  createDocumentWithContent(input: {
    workspaceId: string;
    parentId: string | null;
    title: string;
    contentJson: unknown;
    textSnapshot: string;
  }): Promise<Page | null>;
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

/**
 * 聚合四个窄 Context 为原 AppState 全集；必须在 AppProviders 内使用。
 */
export function useApp(): AppState {
  const session = useContext(WorkspaceSessionContext);
  const navigation = useContext(NavigationContext);
  const preferencesCtx = useContext(PreferencesContext);
  const overlay = useOverlay();
  // 派生字段：回收站页面由会话 pages 派生（R003 §6.5 派生状态本地化）。
  const sessionPages = session?.pages;
  const trashedPages = useMemo(
    () => (sessionPages ?? []).filter((p) => p.deletedAt !== null),
    [sessionPages],
  );
  if (!session || !navigation || !preferencesCtx) {
    throw new Error("useApp 必须在 AppProviders 内使用");
  }
  return {
    ...session,
    ...navigation,
    ...preferencesCtx,
    trashedPages,
    settingsOpen: overlay.settingsOpen,
    openSettings: overlay.openSettings,
    closeSettings: overlay.closeSettings,
  };
}
