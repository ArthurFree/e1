/**
 * 知识库会话状态域（R003 阶段 6 引入，R004 §4.6 细分）：当前知识库及其
 * 页面/标签/关联数据与全部写操作。Provider 由 AppProviders 统一装配，
 * 本文件定义契约与读取入口。
 *
 * Context 细分为两片（R004 §4.6）：
 * - WorkspaceDataContext：数据切片，随会话/页面/标签变化而更新；
 * - WorkspaceCommandContext：命令切片，全部动作引用稳定（经 ref 读取
 *   最新数据），数据变化不会引起纯命令消费者重渲染。
 * 聚合 hook useWorkspaceSession() 同时订阅两片，value 形状与细分前一致，
 * 供既有测试与尚未细分的调用方过渡使用；生产组件按需取其一或两者。
 */
import { createContext, useContext } from "react";
import type {
  Page,
  PageKind,
  PageTag,
  SearchResult,
  Tag,
  Workspace,
} from "../domain/types";

/** 知识库会话加载状态。 */
export type WorkspaceSessionStatus = "idle" | "loading" | "ready" | "error";

/** 知识库会话域的数据切片：随会话数据变化而更新。 */
export interface WorkspaceDataContextValue {
  /** 初始加载（含路由恢复）完成后置为 true。 */
  ready: boolean;
  /** 初始加载失败时的错误信息；为 null 表示正常。 */
  error: string | null;
  /** 全部知识库（含未选中的）。 */
  workspaces: Workspace[];
  /** 当前知识库；未匹配时为 null。 */
  workspace: Workspace | null;
  /** 知识库会话状态：切换期间为 loading，失败为 error。 */
  workspaceStatus: WorkspaceSessionStatus;
  /** 知识库会话加载失败的错误信息；为 null 表示正常。 */
  workspaceError: string | null;
  /** 当前知识库的页面镜像（含分组与回收站条目）。 */
  pages: Page[];
  tags: Tag[];
  /** 当前工作区的全部页面-标签关联。 */
  pageTags: PageTag[];
}

/** 知识库会话域的命令切片：全部动作引用稳定。 */
export interface WorkspaceCommandContextValue {
  /** 初始加载失败后重试。 */
  retryLoad(): void;
  /** 切换当前知识库：原子重载其页面/标签/关联并进入知识库首页。 */
  switchWorkspace(id: string): Promise<void>;
  /** 创建知识库并立即切换过去。 */
  createWorkspace(
    name: string,
    extra?: { icon?: string | null; description?: string },
  ): Promise<void>;
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
  /** 切换文档收藏状态；可作用于其他知识库的页面。 */
  togglePageFavorite(pageId: string): Promise<void>;
  /** 文档在主区域完成渲染后记录最近浏览时间。 */
  markOpened(pageId: string): Promise<void>;
  /** 全局搜索：按标题与正文快照匹配当前工作区文档。 */
  search(query: string): Promise<SearchResult[]>;
}

/** 聚合形状（与细分前一致）：数据切片 + 命令切片。 */
export type WorkspaceSessionContextValue = WorkspaceDataContextValue &
  WorkspaceCommandContextValue;

export const WorkspaceDataContext =
  createContext<WorkspaceDataContextValue | null>(null);

export const WorkspaceCommandContext =
  createContext<WorkspaceCommandContextValue | null>(null);

/** 读取知识库会话数据切片；在 Provider 外调用直接抛错。 */
export function useWorkspaceData(): WorkspaceDataContextValue {
  const ctx = useContext(WorkspaceDataContext);
  if (!ctx) {
    throw new Error("useWorkspaceData 必须在 AppProvider 内使用");
  }
  return ctx;
}

/** 读取知识库会话命令切片；在 Provider 外调用直接抛错。 */
export function useWorkspaceCommands(): WorkspaceCommandContextValue {
  const ctx = useContext(WorkspaceCommandContext);
  if (!ctx) {
    throw new Error("useWorkspaceCommands 必须在 AppProvider 内使用");
  }
  return ctx;
}

/**
 * 聚合读取知识库会话域（数据 + 命令，形状不变）；同时订阅两片 Context，
 * 仅供既有测试与过渡调用方使用，生产组件应改用 useWorkspaceData /
 * useWorkspaceCommands 以获得更细的渲染粒度。
 */
export function useWorkspaceSession(): WorkspaceSessionContextValue {
  return { ...useWorkspaceData(), ...useWorkspaceCommands() };
}
