import { useCallback, useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";
import type { DocumentContent } from "../domain/types";
import { jsonToMarkdown } from "../editor/markdown";
import { contentRepository } from "../infrastructure/repositories";
import { useApp } from "../state/AppState";
import { TitleEditor } from "./TitleEditor";
import { TagPicker } from "./TagPicker";
import { DocumentEditor } from "./editor/DocumentEditor";
import { EmojiPicker } from "./editor/EmojiPicker";
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

/** 主栏：顶部控制条 + 文档头（图标、标题）+ 编辑器画布。 */
export function MainArea({ onOpenTree }: MainAreaProps) {
  const { pages, selectedPageId, renamePage, preferences, setTheme } = useApp();
  const page = pages.find((p) => p.id === selectedPageId) ?? null;
  const [content, setContent] = useState<DocumentContent | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const [, setHistoryTick] = useState(0);

  // 跟踪编辑历史变化，实时更新撤销/重做可用状态。
  useEffect(() => {
    if (!editor) return;
    const refresh = () => setHistoryTick((t) => t + 1);
    editor.on("transaction", refresh);
    return () => {
      editor.off("transaction", refresh);
    };
  }, [editor]);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    if (page?.kind === "document") {
      void contentRepository.get(page.id).then((result) => {
        // 新建文档尚无内容行：以空文档作为初始内容，首次编辑即落盘。
        if (!cancelled) setContent(result ?? emptyContent(page.id));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [page?.id, page?.kind]);

  const onEditorReady = useCallback((instance: Editor | null) => {
    setEditor(instance);
  }, []);

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
        <button
          type="button"
          className="icon-button"
          aria-label="撤销"
          disabled={!liveEditor?.can().undo()}
          onClick={() => liveEditor?.chain().focus().undo().run()}
        >
          ↩
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="重做"
          disabled={!liveEditor?.can().redo()}
          onClick={() => liveEditor?.chain().focus().redo().run()}
        >
          ↪
        </button>
        {liveEditor && <EmojiPicker editor={liveEditor} />}
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
