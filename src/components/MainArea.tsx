import { useCallback, useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";
import type { DocumentContent } from "../domain/types";
import { jsonToMarkdown } from "../editor/markdown";
import { contentRepository } from "../infrastructure/repositories";
import { useApp } from "../state/AppState";
import { TitleEditor } from "./TitleEditor";
import { TagPicker } from "./TagPicker";
import { StartPage } from "./StartPage";
import { RecentPage } from "./RecentPage";
import { FavoritesPage } from "./FavoritesPage";
import { WorkspaceHome } from "./WorkspaceHome";
import { DocumentEditor } from "./editor/DocumentEditor";
import { FormatToolbar } from "./editor/FormatToolbar";
import { TocPanel } from "./editor/TocPanel";

interface MainAreaProps {
  onOpenTree(): void;
}

/** 新建文档的初始空内容（尚无 IndexedDB 内容行时使用）。 */
function emptyContent(pageId: string): DocumentContent {
  return {
    pageId,
    contentJson: { type: "doc", content: [{ type: "paragraph" }] },
    textSnapshot: "",
    updatedAt: Date.now(),
  };
}

/** 主栏：按视图渲染开始首页 / 知识库首页 / 文档编辑区。 */
export function MainArea({ onOpenTree }: MainAreaProps) {
  const {
    pages,
    selectedPageId,
    view,
    renamePage,
    preferences,
    setTheme,
    markOpened,
    togglePageFavorite,
    titleFocusPageId,
    clearTitleFocus,
  } = useApp();
  const page = pages.find((p) => p.id === selectedPageId) ?? null;
  const [content, setContent] = useState<DocumentContent | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [tocOpen, setTocOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    if (view === "document" && page?.kind === "document") {
      void contentRepository.get(page.id).then((result) => {
        // 新建文档尚无内容行：以空文档作为初始内容，首次编辑即落盘。
        if (!cancelled) setContent(result ?? emptyContent(page.id));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [view, page?.id, page?.kind]);

  const onEditorReady = useCallback((instance: Editor | null) => {
    setEditor(instance);
  }, []);

  // 文档在主区域完成渲染后记录最近浏览时间（仅打开，不含搜索预览）。
  useEffect(() => {
    if (view === "document" && page?.kind === "document" && content) {
      void markOpened(page.id);
    }
    // content 随页面加载一次性落地，用 pageId 标识即可。
  }, [view, page?.id, page?.kind, content?.pageId, markOpened]);

  // 切换/新建文档时旧编辑器先销毁、onEditorReady(null) 后落地，
  // 期间状态里仍是已销毁实例，调用其 API 会抛错，需以 isDestroyed 兜底。
  const liveEditor = editor !== null && !editor.isDestroyed ? editor : null;

  const toggleTheme = () => {
    void setTheme(preferences.theme === "dark" ? "light" : "dark");
  };

  const exportMarkdown = () => {
    if (!editor || !page) return;
    const markdown = jsonToMarkdown(editor.getJSON());
    const url = URL.createObjectURL(
      new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${page.title || "无标题"}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const isDocument = page?.kind === "document";

  if (view === "start") {
    return (
      <main className="main">
        <StartPage onOpenTree={onOpenTree} />
      </main>
    );
  }
  if (view === "recent") {
    return (
      <main className="main">
        <RecentPage onOpenTree={onOpenTree} />
      </main>
    );
  }
  if (view === "favorites") {
    return (
      <main className="main">
        <FavoritesPage onOpenTree={onOpenTree} />
      </main>
    );
  }
  if (view === "workspace") {
    return (
      <main className="main">
        <WorkspaceHome onOpenTree={onOpenTree} />
      </main>
    );
  }

  return (
    <main className="main">
      <header className="topbar">
        <button
          type="button"
          className="icon-button tree-toggle"
          aria-label="打开文档树"
          onClick={onOpenTree}
        >
          ☰
        </button>
        <span className="topbar__title">{page?.title || "无标题"}</span>
        <div className="topbar__spacer" />
        {isDocument && (
          <button
            type="button"
            className="icon-button"
            aria-label={page.favoriteAt === null ? "收藏文档" : "取消收藏文档"}
            aria-pressed={page.favoriteAt !== null}
            title={page.favoriteAt === null ? "收藏" : "取消收藏"}
            onClick={() => void togglePageFavorite(page.id)}
          >
            {page.favoriteAt === null ? "☆" : "★"}
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label="导出 Markdown"
          title="导出 Markdown"
          disabled={!liveEditor}
          onClick={exportMarkdown}
        >
          📤
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="目录"
          aria-pressed={tocOpen}
          disabled={!liveEditor}
          onClick={() => setTocOpen((v) => !v)}
        >
          ☰
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={preferences.theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
          onClick={toggleTheme}
        >
          {preferences.theme === "dark" ? "🌞" : "🌙"}
        </button>
      </header>

      {isDocument ? (
        <div className="doc-layout">
          {liveEditor && <FormatToolbar editor={liveEditor} />}
          <div className="doc-scroll">
            <div className="doc-header">
              {page.icon && (
                <div className="doc-header__icon" aria-hidden="true">
                  {page.icon}
                </div>
              )}
              <TitleEditor
                pageId={page.id}
                title={page.title}
                autoFocus={page.id === titleFocusPageId}
                onFocused={clearTitleFocus}
                onSave={(id, title) => void renamePage(id, title || "无标题")}
              />
              <TagPicker pageId={page.id} />
            </div>
            <div className="doc-body">
              {content ? (
                <DocumentEditor
                  pageId={page.id}
                  initialContent={content.contentJson}
                  onEditorReady={onEditorReady}
                />
              ) : (
                <p className="doc-placeholder">正在加载文档…</p>
              )}
            </div>
          </div>
          {tocOpen && liveEditor && <TocPanel editor={liveEditor} />}
        </div>
      ) : (
        <div className="main-empty">从左侧选择或新建一篇文档。</div>
      )}
    </main>
  );
}
