import { useEffect, useMemo, useState } from "react";
import type { Page } from "../domain/types";
import {
  buildActivityRows,
  formatRelativeTime,
  type ActivityTab,
} from "../domain/activity";
import { pageRepository } from "../infrastructure/repositories";
import { useApp } from "../state/AppState";
import { PageIcon } from "./ui/icons";

interface StartPreviewProps {
  onClose(): void;
}

const PREVIEW_LIMIT = 5;

/** 侧栏“开始”入口的悬停/聚焦预览：最多 5 条最近文档，只用于快速打开。 */
export function StartPreview({ onClose }: StartPreviewProps) {
  const { workspaces, openDocument } = useApp();
  const [allPages, setAllPages] = useState<Page[]>([]);
  const [tab, setTab] = useState<ActivityTab>("edited");
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    void pageRepository
      .listAll()
      .then((pages) => {
        if (!cancelled) setAllPages(pages);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(
    () => buildActivityRows({ pages: allPages, workspaces, tab }).slice(0, PREVIEW_LIMIT),
    [allPages, workspaces, tab],
  );

  return (
    <div
      className="start-preview"
      role="dialog"
      aria-label="最近文档预览"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="start-preview__tabs" role="tablist" aria-label="活动类型">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "edited"}
          className={`activity__tab${tab === "edited" ? " activity__tab--active" : ""}`}
          onClick={() => setTab("edited")}
        >
          编辑过
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "viewed"}
          className={`activity__tab${tab === "viewed" ? " activity__tab--active" : ""}`}
          onClick={() => setTab("viewed")}
        >
          浏览过
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="start-preview__empty">
          {tab === "edited" ? "尚未编辑文档" : "尚未浏览文档"}
        </div>
      ) : (
        <ul className="start-preview__list">
          {rows.map((row) => (
            <li key={row.page.id}>
              <button
                type="button"
                className="start-preview__item"
                onClick={() => {
                  onClose();
                  void openDocument(row.page.id);
                }}
              >
                <PageIcon icon={row.page.icon} kind="document" size={14} />
                <span className="start-preview__item-title">
                  {row.page.title || "无标题"}
                </span>
                <span className="start-preview__item-time">
                  {formatRelativeTime(now, row.time)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
