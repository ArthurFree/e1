import { useEffect, useMemo, useState } from "react";
import type { Page } from "../domain/types";
import {
  belongingPath,
  favoritePages,
  favoriteWorkspaces,
  formatRelativeTime,
} from "../domain/activity";
import { pageRepository } from "../infrastructure/repositories";
import { useApp } from "../state/AppState";
import { PageIcon } from "./ui/icons";

interface FavoritesPageProps {
  onOpenTree(): void;
}

/** 全局“收藏”视图：先收藏的知识库，后收藏的文档，均按收藏时间倒序。 */
export function FavoritesPage({ onOpenTree }: FavoritesPageProps) {
  const {
    workspaces,
    openDocument,
    switchWorkspace,
    togglePageFavorite,
    toggleWorkspaceFavorite,
  } = useApp();
  const [allPages, setAllPages] = useState<Page[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    void pageRepository
      .listAll()
      .then((pages) => {
        if (!cancelled) {
          setAllPages(pages);
          setNow(Date.now());
        }
      })
      // 组件卸载或测试重置数据库期间的失败可安全忽略。
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const favWorkspaces = useMemo(() => favoriteWorkspaces(workspaces), [workspaces]);
  const favPages = useMemo(() => favoritePages(allPages), [allPages]);
  const pagesById = useMemo(
    () => new Map(allPages.map((p) => [p.id, p])),
    [allPages],
  );
  const wsNameById = useMemo(
    () => new Map(workspaces.map((w) => [w.id, w.name])),
    [workspaces],
  );

  const onTogglePage = (page: Page) => {
    void togglePageFavorite(page.id).then(() => {
      setAllPages((prev) =>
        prev.map((p) => (p.id === page.id ? { ...p, favoriteAt: null } : p)),
      );
    });
  };

  return (
    <div className="start-page">
      <div className="start-page__inner">
        <header className="start-page__header">
          <button
            type="button"
            className="icon-button tree-toggle"
            aria-label="打开文档树"
            onClick={onOpenTree}
          >
            ☰
          </button>
          <h1 className="start-page__title">收藏</h1>
        </header>

        <section className="favorites__section" aria-label="收藏的知识库">
          <h2 className="favorites__heading">知识库</h2>
          {favWorkspaces.length === 0 ? (
            <div className="activity__empty">还没有收藏的知识库</div>
          ) : (
            <ul className="favorites__list">
              {favWorkspaces.map((ws) => (
                <li key={ws.id} className="favorites__row">
                  <button
                    type="button"
                    className="favorites__title"
                    onClick={() => void switchWorkspace(ws.id)}
                  >
                    <PageIcon icon={ws.icon} kind="workspace" size={14} />
                    {ws.name}
                  </button>
                  <span className="favorites__time">
                    {formatRelativeTime(now, ws.favoriteAt ?? now)}
                  </span>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`取消收藏知识库「${ws.name}」`}
                    title="取消收藏"
                    onClick={() => void toggleWorkspaceFavorite(ws.id)}
                  >
                    ★
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="favorites__section" aria-label="收藏的文档">
          <h2 className="favorites__heading">文档</h2>
          {favPages.length === 0 ? (
            <div className="activity__empty">还没有收藏的文档</div>
          ) : (
            <ul className="favorites__list">
              {favPages.map((page) => (
                <li key={page.id} className="favorites__row">
                  <button
                    type="button"
                    className="favorites__title"
                    onClick={() => void openDocument(page.id)}
                  >
                    <PageIcon icon={page.icon} kind="document" size={14} />
                    {page.title || "无标题"}
                  </button>
                  <span className="favorites__path">
                    {belongingPath(
                      page,
                      pagesById,
                      wsNameById.get(page.workspaceId) ?? "未知知识库",
                    )}
                  </span>
                  <span className="favorites__time">
                    {formatRelativeTime(now, page.favoriteAt ?? now)}
                  </span>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`取消收藏文档「${page.title || "无标题"}」`}
                    title="取消收藏"
                    onClick={() => onTogglePage(page)}
                  >
                    ★
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
