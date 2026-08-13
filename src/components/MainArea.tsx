/**
 * @file 主区组件：应用右侧的视图分发。
 * 依据导航状态中的 `view` 路由渲染开始首页 / 最近浏览 / 收藏 /
 * 知识库首页 / 文档编辑区；知识库会话加载中与加载失败在此兜底。
 * 文档编辑区的编排与外框见 `document/DocumentScreen`。
 */

import {
  useWorkspaceCommands,
  useWorkspaceData,
} from "../state/WorkspaceSessionContext";
import { useNavigationState } from "../state/NavigationContext";
import { StartPage } from "./StartPage";
import { RecentPage } from "./RecentPage";
import { FavoritesPage } from "./FavoritesPage";
import { WorkspaceHome } from "./WorkspaceHome";
import { DocumentScreen } from "./document/DocumentScreen";

/** 主栏：按视图渲染开始首页 / 知识库首页 / 文档编辑区。 */
export function MainArea() {
  const { workspaceStatus, workspaceError } = useWorkspaceData();
  const { retryLoad } = useWorkspaceCommands();
  const { view } = useNavigationState();

  // 知识库会话切换中/失败（R003 阶段 2）：不渲染任何基于旧会话数据的视图。
  if (workspaceStatus === "loading") {
    return (
      <main className="main">
        <div className="main-empty">正在加载知识库…</div>
      </main>
    );
  }
  if (workspaceStatus === "error") {
    return (
      <main className="main">
        <div className="app-error" role="alert">
          <p>{workspaceError ?? "知识库加载失败，请重试。"}</p>
          <button
            type="button"
            className="app-error__retry"
            onClick={retryLoad}
          >
            重试
          </button>
        </div>
      </main>
    );
  }

  if (view === "start") {
    return (
      <main className="main">
        <StartPage />
      </main>
    );
  }
  if (view === "recent") {
    return (
      <main className="main">
        <RecentPage />
      </main>
    );
  }
  if (view === "favorites") {
    return (
      <main className="main">
        <FavoritesPage />
      </main>
    );
  }
  if (view === "workspace") {
    return (
      <main className="main">
        <WorkspaceHome />
      </main>
    );
  }

  return <DocumentScreen />;
}
