/**
 * 知识库会话纯 reducer（R004 阶段 4 自 AppState 提取）：
 * 会话四类数据（workspaceId/pages/tags/pageTags）必须同批次提交，
 * 切换知识库时经 WorkspaceSessionService 一次原子加载，requestId 丢弃过期
 * 响应，UI 永远不会看到新旧知识库混合态（R003 阶段 2）。
 */
import type { Page, PageTag, Tag } from "../../domain/types";
import type { WorkspaceSessionData } from "../../application/services/WorkspaceSessionService";
import type { WorkspaceSessionStatus } from "../WorkspaceSessionContext";

/** 知识库会话：四类数据必须同批次提交，由 reducer 保证原子性。 */
export interface WorkspaceSessionState {
  status: WorkspaceSessionStatus;
  /** 最近一次加载请求的序号；过期响应据此丢弃。 */
  requestId: number;
  workspaceId: string | null;
  pages: Page[];
  tags: Tag[];
  pageTags: PageTag[];
  error: string | null;
}

export type SessionAction =
  | { type: "session/load-start"; requestId: number; workspaceId: string }
  | {
      type: "session/load-success";
      requestId: number;
      data: WorkspaceSessionData;
    }
  | { type: "session/load-error"; requestId: number; error: string }
  | { type: "pages/set"; pages: Page[] | ((prev: Page[]) => Page[]) }
  | {
      type: "tags/set-all";
      tags: Tag[];
      pageTags: PageTag[];
    };

export const initialSession: WorkspaceSessionState = {
  status: "idle",
  requestId: 0,
  workspaceId: null,
  pages: [],
  tags: [],
  pageTags: [],
  error: null,
};

export function sessionReducer(
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
