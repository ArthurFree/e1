import { useEffect, useState } from "react";
import { useApp } from "../state/AppState";
import { GlobalSidebar } from "./shell/GlobalSidebar";
import { PageTreeSidebar } from "./PageTreeSidebar";
import { MainArea } from "./MainArea";

/**
 * @file 应用壳组件：整个应用的最外层布局容器。
 * 组合全局侧栏（GlobalSidebar）、知识库侧栏（PageTreeSidebar，窄屏时抽屉化）
 * 与主区（MainArea），并负责把主题偏好落到 `<html data-theme>` 上供
 * tokens.css 的浅/深令牌切换消费（R002）。
 */

/** 应用壳：全局侧栏 + 知识库侧栏（窄屏抽屉化）+ 主区。 */
export function AppShell() {
  const { ready, error, retryLoad, preferences } = useApp();
  // 窄屏下文档树以抽屉形式覆盖主区，treeOpen 控制抽屉与遮罩的显隐
  const [treeOpen, setTreeOpen] = useState(false);

  // 主题切换不经过 React 渲染，直接写根元素 data-theme，让 CSS 变量即时生效
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
