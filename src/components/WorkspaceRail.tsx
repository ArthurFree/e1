import { useState } from "react";
import { useApp } from "../state/AppState";
import { SearchPanel } from "./SearchPanel";
import { TrashPanel } from "./TrashPanel";
import { SettingsPanel } from "./SettingsPanel";
import { StartPreview } from "./StartPreview";

/** 最左侧工作区轨道：开始首页 + 知识库切换 + 搜索/回收站/设置入口。 */
export function WorkspaceRail() {
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
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  return (
    <nav className="rail" aria-label="工作区">
      <div
        className="rail__start"
        onMouseEnter={() => setPreviewOpen(true)}
        onMouseLeave={() => setPreviewOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setPreviewOpen(false);
        }}
      >
        <button
          type="button"
          className={`icon-button${view === "start" ? " icon-button--active" : ""}`}
          aria-label="开始"
          title="开始"
          onClick={() => {
            setPreviewOpen(false);
            showStart();
          }}
          onFocus={() => setPreviewOpen(true)}
        >
          🏠
        </button>
        {previewOpen && <StartPreview onClose={() => setPreviewOpen(false)} />}
      </div>

      <div className="rail__workspace">
        <button
          type="button"
          className="icon-button"
          aria-label="切换知识库"
          title={workspace?.name ?? "知识库"}
          onClick={() => setSwitcherOpen((open) => !open)}
        >
          {workspace?.icon ?? "📚"}
        </button>
        <span className="rail__workspace-name">{workspace?.name ?? ""}</span>
      </div>

      <button
        type="button"
        className="icon-button"
        aria-label="搜索"
        title="搜索"
        onClick={() => setSearchOpen(true)}
      >
        🔍
      </button>

      <button
        type="button"
        className={`icon-button${view === "recent" ? " icon-button--active" : ""}`}
        aria-label="最近"
        title="最近"
        onClick={showRecent}
      >
        🕘
      </button>
      <button
        type="button"
        className={`icon-button${view === "favorites" ? " icon-button--active" : ""}`}
        aria-label="收藏"
        title="收藏"
        onClick={showFavorites}
      >
        ⭐
      </button>

      <div className="rail__spacer" />

      <button
        type="button"
        className="icon-button"
        aria-label="回收站"
        title="回收站"
        onClick={() => setTrashOpen(true)}
      >
        🗑️
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label="设置"
        title="设置"
        onClick={openSettings}
      >
        ⚙️
      </button>

      {searchOpen && <SearchPanel onClose={() => setSearchOpen(false)} />}
      {trashOpen && <TrashPanel onClose={() => setTrashOpen(false)} />}
      {settingsOpen && <SettingsPanel />}

      {switcherOpen && (
        <div role="menu" aria-label="知识库列表" className="rail-switcher">
          {workspaces.map((ws) => (
            <button
              key={ws.id}
              type="button"
              role="menuitem"
              className="tree-row"
              onClick={() => {
                void switchWorkspace(ws.id);
                setSwitcherOpen(false);
              }}
            >
              <span className="tree-row__title">{ws.name}</span>
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className="tree-row"
            onClick={() => {
              void createWorkspace("新建知识库");
              setSwitcherOpen(false);
            }}
          >
            <span className="tree-row__title">＋ 新建知识库</span>
          </button>
        </div>
      )}
    </nav>
  );
}
