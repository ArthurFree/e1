/**
 * @file 全局侧栏（R002 §7.1）：贯穿所有视图的一级导航。
 * 自上而下为账户行、搜索入口、主导航（开始 / 最近 / 收藏）、知识库列表
 * 与底部工具区（回收站 / 设置）；搜索、回收站、设置三个面板也在此挂载。
 * 「开始」项悬停或聚焦时弹出 StartPreview 快速预览最近文档。
 * ≥1280px 完整 240px；1024–1279px 折叠为 64px 图标栏；<1024px 隐藏
 * （窄屏导航由树抽屉承担，见 R002 偏差记录）。
 */

import { useState } from "react";
import { useApp } from "../../state/AppState";
import { SearchPanel } from "../SearchPanel";
import { TrashPanel } from "../TrashPanel";
import { SettingsPanel } from "../SettingsPanel";
import { StartPreview } from "../StartPreview";
import {
  IconBook,
  IconClock,
  IconHome,
  IconPlus,
  IconSearch,
  IconSettings,
  IconStar,
  IconTrash,
} from "../ui/icons";

/**
 * 全局侧栏（R002 §7.1）：账户行、搜索、主导航（开始/最近/收藏）、
 * 知识库列表与底部工具区。≥1280px 完整 240px；1024–1279px 折叠为
 * 64px 图标栏；<1024px 隐藏（窄屏导航由树抽屉承担，见 R002 偏差记录）。
 */
export function GlobalSidebar() {
  const {
    workspaces,
    workspace,
    view,
    showStart,
    showRecent,
    showFavorites,
    switchWorkspace,
    createWorkspace,
    settingsOpen,
    openSettings,
  } = useApp();
  const [searchOpen, setSearchOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  return (
    <nav className="gsb" aria-label="全局导航">
      <div className="gsb__account">
        <span className="gsb__logo" aria-hidden="true">
          N
        </span>
        <span className="gsb__label gsb__account-name">个人空间</span>
      </div>

      <button
        type="button"
        className="gsb__search"
        aria-label="搜索"
        title="搜索"
        onClick={() => setSearchOpen(true)}
      >
        <IconSearch />
        <span className="gsb__label">搜索</span>
      </button>

      <div className="gsb__nav">
        <div
          className="gsb__start"
          // 悬停与聚焦都触发预览（键盘用户也能用）；Escape 只关预览不导航
          onMouseEnter={() => setPreviewOpen(true)}
          onMouseLeave={() => setPreviewOpen(false)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setPreviewOpen(false);
          }}
        >
          <button
            type="button"
            className={`gsb__item${view === "start" ? " gsb__item--active" : ""}`}
            aria-label="开始"
            title="开始"
            aria-current={view === "start" ? "page" : undefined}
            onClick={() => {
              setPreviewOpen(false);
              showStart();
            }}
            onFocus={() => setPreviewOpen(true)}
          >
            <IconHome />
            <span className="gsb__label">开始</span>
          </button>
          {previewOpen && <StartPreview onClose={() => setPreviewOpen(false)} />}
        </div>
        <button
          type="button"
          className={`gsb__item${view === "recent" ? " gsb__item--active" : ""}`}
          aria-label="最近"
          title="最近"
          aria-current={view === "recent" ? "page" : undefined}
          onClick={showRecent}
        >
          <IconClock />
          <span className="gsb__label">最近</span>
        </button>
        <button
          type="button"
          className={`gsb__item${view === "favorites" ? " gsb__item--active" : ""}`}
          aria-label="收藏"
          title="收藏"
          aria-current={view === "favorites" ? "page" : undefined}
          onClick={showFavorites}
        >
          <IconStar />
          <span className="gsb__label">收藏</span>
        </button>
      </div>

      <div className="gsb__section">
        <div className="gsb__section-title">
          <span className="gsb__label">知识库</span>
          <button
            type="button"
            className="gsb__section-action"
            aria-label="新建知识库"
            title="新建知识库"
            onClick={() => void createWorkspace("新建知识库")}
          >
            <IconPlus size={14} />
          </button>
        </div>
        {workspaces.map((ws) => (
          <button
            key={ws.id}
            type="button"
            className={`gsb__item gsb__ws${ws.id === workspace?.id ? " gsb__item--active" : ""}`}
            aria-label={`知识库「${ws.name}」`}
            aria-current={ws.id === workspace?.id ? "true" : undefined}
            onClick={() => void switchWorkspace(ws.id)}
          >
            <span className="gsb__ws-icon" aria-hidden="true">
              {ws.icon ?? <IconBook />}
            </span>
            <span className="gsb__label gsb__ws-name">{ws.name}</span>
          </button>
        ))}
      </div>

      <div className="gsb__footer">
        <button
          type="button"
          className="gsb__item"
          aria-label="回收站"
          title="回收站"
          onClick={() => setTrashOpen(true)}
        >
          <IconTrash />
          <span className="gsb__label">回收站</span>
        </button>
        <button
          type="button"
          className="gsb__item"
          aria-label="设置"
          title="设置"
          onClick={openSettings}
        >
          <IconSettings />
          <span className="gsb__label">设置</span>
        </button>
      </div>

      {searchOpen && <SearchPanel onClose={() => setSearchOpen(false)} />}
      {trashOpen && <TrashPanel onClose={() => setTrashOpen(false)} />}
      {settingsOpen && <SettingsPanel />}
    </nav>
  );
}
