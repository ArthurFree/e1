import { useCallback, useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";
import type { DocumentContent } from "../domain/types";
import { contentRepository } from "../infrastructure/repositories";
import { useApp } from "../state/AppState";
import { TitleEditor } from "./TitleEditor";
import { DocumentEditor } from "./editor/DocumentEditor";
import { EmojiPicker } from "./editor/EmojiPicker";
import { TocPanel } from "./editor/TocPanel";

interface MainAreaProps {
  onOpenTree(): void;
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
        if (!cancelled) setContent(result ?? null);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [page?.id, page?.kind]);

  const onEditorReady = useCallback((instance: Editor | null) => {
    setEditor(instance);
  }, []);

  const toggleTheme = () => {
    void setTheme(preferences.theme === "dark" ? "light" : "dark");
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
          disabled={!editor?.can().undo()}
          onClick={() => editor?.chain().focus().undo().run()}
        >
          ↩
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="重做"
          disabled={!editor?.can().redo()}
          onClick={() => editor?.chain().focus().redo().run()}
        >
          ↪
        </button>
        {editor && <EmojiPicker editor={editor} />}
        <button
          type="button"
          className="icon-button"
          aria-label="目录"
          aria-pressed={tocOpen}
          disabled={!editor}
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
          {tocOpen && editor && <TocPanel editor={editor} />}
        </div>
      ) : (
        <div className="main-empty">从左侧选择或新建一篇文档。</div>
      )}
    </main>
  );
}
