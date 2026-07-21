import { ActivityList } from "./ActivityList";

interface RecentPageProps {
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
