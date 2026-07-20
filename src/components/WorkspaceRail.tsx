import { useState } from "react";
import { useApp } from "../state/AppState";

/** 最左侧工作区轨道：知识库切换 + 搜索/设置/回收站入口（后三者为占位）。 */
export function WorkspaceRail() {
  const { workspaces, workspace, switchWorkspace, createWorkspace } = useApp();
  const [switcherOpen, setSwitcherOpen] = useState(false);

  return (
    <nav className="rail" aria-label="工作区">
      <div className="rail__workspace">
        <button
          type="button"
          className="icon-button icon-button--active"
          aria-label="切换知识库"
          title={workspace?.name ?? "知识库"}
          onClick={() => setSwitcherOpen((open) => !open)}
        >
          📚
        </button>
        <span className="rail__workspace-name">{workspace?.name ?? ""}</span>
      </div>

      <button type="button" className="icon-button" aria-label="搜索" disabled title="搜索（后续阶段提供）">
        🔍
      </button>

      <div className="rail__spacer" />

      <button type="button" className="icon-button" aria-label="回收站" disabled title="回收站（后续阶段提供）">
        🗑️
      </button>
      <button type="button" className="icon-button" aria-label="设置" disabled title="设置（后续阶段提供）">
        ⚙️
      </button>

      {switcherOpen && (
        <div
          role="menu"
          aria-label="知识库列表"
          style={{
            position: "fixed",
            left: 60,
            bottom: 12,
            zIndex: 40,
            minWidth: 180,
            padding: 6,
            background: "var(--bg-canvas)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-lg)",
            boxShadow: "var(--shadow-popover)",
          }}
        >
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
