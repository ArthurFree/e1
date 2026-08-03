import { useEffect, useState } from "react";
import type { StorageConnectionEvent } from "../application/services/StorageConnectionEventBus";
import { useAppServices } from "../state/AppServicesProvider";
import {
  useWorkspaceCommands,
  useWorkspaceData,
} from "../state/WorkspaceSessionContext";
import { usePreferences } from "../state/PreferencesContext";
import { useOverlay } from "../state/OverlayContext";
import { GlobalSidebar } from "./shell/GlobalSidebar";
import { PageTreeSidebar } from "./PageTreeSidebar";
import { MainArea } from "./MainArea";

/**
 * @file 应用壳组件：整个应用的最外层布局容器。
 * 组合全局侧栏（GlobalSidebar）、知识库侧栏（PageTreeSidebar，窄屏时抽屉化）
 * 与主区（MainArea），并负责把主题偏好落到 `<html data-theme>` 上供
 * tokens.css 的浅/深令牌切换消费（R002）。
 * 窄屏文档树抽屉的开关由 OverlayContext 统一持有（R003 阶段 6）。
 * 存储连接事件提示条（R004 阶段 7 §7.1）：数据库升级被其他标签页阻塞、
 * 或其他标签页完成升级时给出可恢复提示，不白屏。
 */

/** 应用壳：全局侧栏 + 知识库侧栏（窄屏抽屉化）+ 主区。 */
export function AppShell() {
  const services = useAppServices();
  const { ready, error } = useWorkspaceData();
  const { retryLoad } = useWorkspaceCommands();
  const { preferences } = usePreferences();
  const { treeDrawerOpen, closeTreeDrawer } = useOverlay();
  // 存储连接事件（R004 §7.1）：blocked 与 versionchange 需要用户动作；
  // terminated 已自动重连（缓存清空），不打扰用户。
  const [storageEvent, setStorageEvent] =
    useState<StorageConnectionEvent | null>(null);

  // 主题切换不经过 React 渲染，直接写根元素 data-theme，让 CSS 变量即时生效
  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme;
  }, [preferences.theme]);

  useEffect(() => {
    return services.storageEvents.subscribe((event) => {
      if (event === "terminated") return;
      setStorageEvent(event);
    });
  }, [services]);

  if (!ready) {
    if (error) {
      return (
        <div className="loading">
          <div className="app-error" role="alert">
            <p>{error}</p>
            <button
              type="button"
              className="app-error__retry"
              onClick={retryLoad}
            >
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
      {storageEvent && (
        <div className="storage-banner" role="alert">
          <span className="storage-banner__text">
            {storageEvent === "blocked"
              ? "数据库升级被其他标签页阻塞，请关闭其他打开本应用的标签页。"
              : "应用已在其他标签页更新，请刷新本页面以继续使用。"}
          </span>
          {storageEvent === "versionchange" && (
            <button
              type="button"
              className="storage-banner__action"
              onClick={() => window.location.reload()}
            >
              刷新页面
            </button>
          )}
          <button
            type="button"
            className="storage-banner__dismiss"
            aria-label="关闭提示"
            onClick={() => setStorageEvent(null)}
          >
            ×
          </button>
        </div>
      )}
      <GlobalSidebar />
      <PageTreeSidebar />
      {treeDrawerOpen && (
        <div
          className="backdrop"
          aria-hidden="true"
          onClick={closeTreeDrawer}
        />
      )}
      <MainArea />
    </div>
  );
}
