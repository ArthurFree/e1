/**
 * @file 「最近」视图：跨知识库的最近编辑 / 最近浏览列表。
 * 布局与 StartPage 共用 start-page 系列样式，正文直接复用 ActivityList，
 * 本身只提供页头与容器。
 */

import { ActivityList } from "./ActivityList";

interface RecentPageProps {
  /** 打开窄屏抽屉式文档树的回调，由 MainArea 透传。 */
  onOpenTree(): void;
}

/** 全局“最近”视图：跨知识库的最近编辑与最近浏览。 */
export function RecentPage({ onOpenTree }: RecentPageProps) {
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
          <h1 className="start-page__title">最近</h1>
        </header>
        <ActivityList />
      </div>
    </div>
  );
}
