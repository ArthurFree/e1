import { useEffect, useState } from "react";
import { useApp } from "../state/AppState";
import { WorkspaceRail } from "./WorkspaceRail";
import { PageTreeSidebar } from "./PageTreeSidebar";
import { MainArea } from "./MainArea";

/** 应用壳：工作区轨道 + 文档树侧栏（窄屏抽屉化）+ 主栏。 */
export function AppShell() {
  const { ready, preferences } = useApp();
  const [treeOpen, setTreeOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme;
  }, [preferences.theme]);

  if (!ready) {
    return <div className="loading">正在加载本地知识库…</div>;
  }

  return (
    <div className="app-shell">
      <WorkspaceRail />
      <PageTreeSidebar open={treeOpen} onClose={() => setTreeOpen(false)} />
      {treeOpen && (
        <div
          className="backdrop"
          aria-hidden="true"
          onClick={() => setTreeOpen(false)}
        />
      )}
      <MainArea onOpenTree={() => setTreeOpen(true)} />
    </div>
  );
}
