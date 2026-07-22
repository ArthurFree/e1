import { useEffect, useState } from "react";
import { useApp } from "../state/AppState";
import { GlobalSidebar } from "./shell/GlobalSidebar";
import { PageTreeSidebar } from "./PageTreeSidebar";
import { MainArea } from "./MainArea";

/** 应用壳：全局侧栏 + 知识库侧栏（窄屏抽屉化）+ 主区。 */
export function AppShell() {
  const { ready, error, retryLoad, preferences } = useApp();
  const [treeOpen, setTreeOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme;
  }, [preferences.theme]);

  if (!ready) {
    if (error) {
      return (
        <div className="loading">
          <div className="app-error" role="alert">
            <p>{error}</p>
            <button type="button" className="app-error__retry" onClick={retryLoad}>
              重试
            </button>
          </div>
        </div>
      );
    }
    return <div className="loading">正在加载本地知识库…</div>;
  }

  return (
    <div className="app-shell">
      <GlobalSidebar />
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
