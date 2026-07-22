/**
 * @file 跨知识库文档活动列表组件。
 * 提供「编辑过 / 浏览过」页签、按知识库筛选与分页加载，开始首页（StartPage）
 * 与「最近浏览」视图（RecentPage）共用。排序、归属路径与相对时间格式等
 * 纯逻辑在 domain/activity.ts，本组件只负责取数与渲染。
 */

import { useEffect, useMemo, useState } from "react";
import type { Page } from "../domain/types";
import {
  ACTIVITY_PAGE_SIZE,
  buildActivityRows,
  formatRelativeTime,
  type ActivityTab,
} from "../domain/activity";
import { pageRepository } from "../infrastructure/repositories";
import { useApp } from "../state/AppState";
import { IconStar, IconStarFilled, PageIcon } from "./ui/icons";

/**
 * 跨知识库文档活动列表：编辑过/浏览过页签、归属筛选、分页与空态。
 * 开始首页与“最近”视图共用。
 */
export function ActivityList() {
  const { workspaces, openDocument, locatePage, togglePageFavorite } = useApp();
  const [allPages, setAllPages] = useState<Page[]>([]);
  const [tab, setTab] = useState<ActivityTab>("edited");
  const [filterWorkspaceId, setFilterWorkspaceId] = useState<string | null>(null);
  const [limit, setLimit] = useState(ACTIVITY_PAGE_SIZE);
  const [now, setNow] = useState(() => Date.now());

  // 直接经仓储取全量页面而非走 AppState：活动列表需要跨知识库的软删排除全集，
  // AppState 只持有当前知识库的页面子集
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

  const rows = useMemo(
    () =>
      buildActivityRows({
        pages: allPages,
        workspaces,
        tab,
        workspaceId: filterWorkspaceId,
      }),
    [allPages, workspaces, tab, filterWorkspaceId],
  );
  const visibleRows = rows.slice(0, limit);

  const onToggleFavorite = (page: Page) => {
    // 本地 allPages 是仓储数据的快照，收藏成功后需同步修补，
    // 否则行内星标不会即时翻转（不触发整表重取以保留滚动位置）
    void togglePageFavorite(page.id).then(() => {
      const next = page.favoriteAt === null ? Date.now() : null;
      setAllPages((prev) =>
        prev.map((p) => (p.id === page.id ? { ...p, favoriteAt: next } : p)),
      );
    });
  };

  const emptyText =
    rows.length === 0 && filterWorkspaceId
      ? "筛选后无结果"
      : tab === "edited"
        ? "尚未编辑文档"
        : "尚未浏览文档";

  return (
    <section className="activity" aria-label="文档活动">
      <div className="activity__bar">
        <div className="activity__tabs" role="tablist" aria-label="活动类型">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "edited"}
            className={`activity__tab${tab === "edited" ? " activity__tab--active" : ""}`}
            onClick={() => {
              setTab("edited");
              setLimit(ACTIVITY_PAGE_SIZE);
            }}
          >
            编辑过
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "viewed"}
            className={`activity__tab${tab === "viewed" ? " activity__tab--active" : ""}`}
            onClick={() => {
              setTab("viewed");
              setLimit(ACTIVITY_PAGE_SIZE);
            }}
          >
            浏览过
          </button>
        </div>
        <select
          className="activity__filter"
          aria-label="按知识库筛选"
          value={filterWorkspaceId ?? ""}
          onChange={(event) => {
            setFilterWorkspaceId(event.target.value || null);
            setLimit(ACTIVITY_PAGE_SIZE);
          }}
        >
          <option value="">全部知识库</option>
          {workspaces.map((ws) => (
            <option key={ws.id} value={ws.id}>
              {ws.name}
            </option>
          ))}
        </select>
      </div>

      {visibleRows.length === 0 ? (
        <div className="activity__empty">{emptyText}</div>
      ) : (
        <table className="activity-table">
          <thead>
            <tr>
              <th scope="col">标题</th>
              <th scope="col" className="activity-table__type">类型</th>
              <th scope="col">归属</th>
              <th scope="col">时间</th>
              <th scope="col" className="activity-table__fav">
                <span className="sr-only">收藏</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr key={row.page.id}>
                <td>
                  <button
                    type="button"
                    className="activity-table__title"
                    onClick={() => void openDocument(row.page.id)}
                  >
                    <PageIcon icon={row.page.icon} kind="document" size={14} />
                    {row.page.title || "无标题"}
                  </button>
                </td>
                <td className="activity-table__type">文档</td>
                <td>
                  <button
                    type="button"
                    className="activity-table__path"
                    title="进入所属知识库并定位"
                    onClick={() => void locatePage(row.page.id)}
                  >
                    {row.path}
                  </button>
                </td>
                <td className="activity-table__time">
                  {formatRelativeTime(now, row.time)}
                </td>
                <td className="activity-table__fav">
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={row.page.favoriteAt === null ? "收藏文档" : "取消收藏文档"}
                    aria-pressed={row.page.favoriteAt !== null}
                    title={row.page.favoriteAt === null ? "收藏" : "取消收藏"}
                    onClick={() => onToggleFavorite(row.page)}
                  >
                    {row.page.favoriteAt === null ? <IconStar size={14} /> : <IconStarFilled size={14} />}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length > limit && (
        <button
          type="button"
          className="activity__more"
          onClick={() => setLimit((n) => n + ACTIVITY_PAGE_SIZE)}
        >
          查看更多（还有 {rows.length - limit} 条）
        </button>
      )}
    </section>
  );
}
