import { useEffect, useMemo, useState } from "react";
import type { DocumentContent, Page } from "../domain/types";
import { formatRelativeTime, workspaceDocStats } from "../domain/activity";
import { childrenOf } from "../domain/pageTree";
import { contentRepository } from "../infrastructure/repositories";
import { useApp } from "../state/AppState";
import { PageIcon } from "./ui/icons";

interface WorkspaceHomeProps {
  onOpenTree(): void;
}

/** 知识库首页：头部信息、统计、主操作与完整目录概览（不拖拽）。 */
export function WorkspaceHome({ onOpenTree }: WorkspaceHomeProps) {
  const {
    workspace,
    pages,
    createPage,
    openDocument,
    toggleWorkspaceFavorite,
  } = useApp();
  const [contents, setContents] = useState<DocumentContent[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    void contentRepository.listAll().then((list) => {
      if (!cancelled) setContents(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const stats = useMemo(
    () => (workspace ? workspaceDocStats(pages, contents, workspace.id) : null),
    [workspace, pages, contents],
  );

  if (!workspace) {
    return <div className="main-empty">请选择或新建一个知识库。</div>;
  }

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderDocRow = (page: Page) => (
    <div key={page.id} className="ws-home__doc">
      <button
        type="button"
        className="ws-home__doc-title"
        onClick={() => void openDocument(page.id)}
      >
        <PageIcon icon={page.icon} kind="document" size={14} />
        {page.title || "无标题"}
      </button>
      <span className="ws-home__doc-time">
        {formatRelativeTime(now, page.updatedAt)}
      </span>
    </div>
  );

  const renderNodes = (parentId: string | null, depth: number) => {
    const nodes = childrenOf(pages, parentId).filter(
      (p) => p.workspaceId === workspace.id,
    );
    return nodes.map((page) => {
      if (page.kind === "document") return renderDocRow(page);
      const children = childrenOf(pages, page.id);
      const isCollapsed = collapsed.has(page.id);
      return (
        <section
          key={page.id}
          className="ws-home__group"
          style={{ marginLeft: depth * 16 }}
          aria-label={page.title || "未命名分组"}
        >
          <button
            type="button"
            className="ws-home__group-header"
            aria-expanded={!isCollapsed}
            onClick={() => toggleCollapse(page.id)}
          >
            <span aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>
            <PageIcon icon={page.icon} kind="group" size={14} />
            {page.title || "未命名分组"}
          </button>
          {!isCollapsed &&
            (children.length > 0 ? (
              renderNodes(page.id, 0)
            ) : (
              <div className="ws-home__group-empty">空分组</div>
            ))}
        </section>
      );
    });
  };

  const topLevel = childrenOf(pages, null).filter(
    (p) => p.workspaceId === workspace.id,
  );
  const favorite = workspace.favoriteAt !== null;

  return (
    <div className="ws-home">
      <div className="ws-home__inner">
        <header className="ws-home__header">
          <button
            type="button"
            className="icon-button tree-toggle"
            aria-label="打开文档树"
            onClick={onOpenTree}
          >
            ☰
          </button>
          <span className="ws-home__icon" aria-hidden="true">
            {workspace.icon ?? "📚"}
          </span>
          <div className="ws-home__heading">
            <h1 className="ws-home__name">{workspace.name}</h1>
            <p className="ws-home__desc">
              {workspace.description ||
                "用分组组织这个知识库的文档；从下方目录或左侧树开始。"}
            </p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={favorite ? "取消收藏知识库" : "收藏知识库"}
            aria-pressed={favorite}
            title={favorite ? "取消收藏" : "收藏"}
            onClick={() => void toggleWorkspaceFavorite(workspace.id)}
          >
            {favorite ? "★" : "☆"}
          </button>
        </header>

        <div className="ws-home__meta">
          <span>{stats?.docCount ?? 0} 篇文档</span>
          <span aria-hidden="true">·</span>
          <span>共 {(stats?.totalChars ?? 0).toLocaleString()} 字</span>
          <span className="ws-home__meta-spacer" />
          <button
            type="button"
            className="button button--primary"
            onClick={() => void createPage("document", null)}
          >
            新建文档
          </button>
          <button
            type="button"
            className="button"
            onClick={() => void createPage("group", null)}
          >
            新建分组
          </button>
        </div>

        <section className="ws-home__toc" aria-label="目录概览">
          <h2 className="ws-home__toc-title">目录</h2>
          {topLevel.length === 0 ? (
            <div className="ws-home__empty">
              这个知识库还是空的。点击「新建文档」写下第一篇，或用「新建分组」先规划结构。
            </div>
          ) : (
            renderNodes(null, 0)
          )}
        </section>
      </div>
    </div>
  );
}
