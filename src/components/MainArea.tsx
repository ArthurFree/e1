/**
 * @file 主区组件：应用右侧的内容分发与文档编辑宿主。
 * 依据 AppState 中的 `view` 路由渲染开始首页 / 最近浏览 / 收藏 /
 * 知识库首页 / 文档编辑区（R002 的 48px 顶栏 + 工具栏 + 780px 正文布局在此组装），
 * 并承担文档内容的加载、最近浏览记录、主题切换与 Markdown 导出。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import type { DocumentContent } from "../domain/types";
import { jsonToMarkdown } from "../editor/markdown";
import { contentRepository } from "../infrastructure/repositories";
import {
  discardRecovery,
  readRecovery,
  type DocumentRecoveryRecord,
} from "../application/services/documentRecovery";
import {
  clearCorruptedDiagnostic,
  writeCorruptedDiagnostic,
} from "../application/services/corruptedDiagnostics";
import {
  parseDocumentContent,
  sanitizeDocumentContent,
} from "../domain/validation/documentContent";
import { useApp } from "../state/AppState";
import { Button } from "./ui/Button";
import { TitleEditor } from "./TitleEditor";
import { TagPicker } from "./TagPicker";
import { StartPage } from "./StartPage";
import { RecentPage } from "./RecentPage";
import { FavoritesPage } from "./FavoritesPage";
import { WorkspaceHome } from "./WorkspaceHome";
import { VersionPanel } from "./VersionPanel";
import { DocumentEditor, type SaveState } from "./editor/DocumentEditor";
import { FormatToolbar } from "./editor/FormatToolbar";
import { TocPanel } from "./editor/TocPanel";
import { WordCount } from "./editor/WordCount";
import { SaveStateIndicator } from "./editor/SaveStateIndicator";
import {
  IconClock,
  IconExport,
  IconList,
  IconMenu,
  IconMoon,
  IconStar,
  IconStarFilled,
  IconSun,
} from "./ui/icons";

interface MainAreaProps {
  /** 打开窄屏抽屉式文档树的回调，由 AppShell 注入。 */
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
    workspaceStatus,
    workspaceError,
    retryLoad,
  } = useApp();
  const page = pages.find((p) => p.id === selectedPageId) ?? null;
  const [content, setContent] = useState<DocumentContent | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>({ status: "saved", savedAt: null });
  // 未落盘编辑的恢复提示（R003 §1.4）：恢复缓冲比 IndexedDB 正文更新时出现。
  const [recovery, setRecovery] = useState<DocumentRecoveryRecord | null>(null);
  // 正文 JSON 校验失败（R003 阶段 4）：不渲染编辑器，显示损坏处理面板。
  const [corrupted, setCorrupted] = useState<{ raw: unknown; error: string } | null>(null);
  // 应用恢复后递增：强制编辑器以恢复内容重建，并触发一次立即保存。
  const [contentEpoch, setContentEpoch] = useState(0);
  const retrySaveRef = useRef<(() => void) | null>(null);
  // 标题 Enter/ArrowDown 时正文编辑器可能尚未就绪；就绪后补一次聚焦首行。
  const pendingExitToBodyRef = useRef(false);

  useEffect(() => {
    // cancelled 防止竞态：快速切换页面时旧请求晚到不得覆盖新页面的内容
    let cancelled = false;
    setContent(null);
    setRecovery(null);
    setCorrupted(null);
    pendingExitToBodyRef.current = false;
    if (view === "document" && page?.kind === "document") {
      void contentRepository.get(page.id).then((result) => {
        if (cancelled) return;
        // 新建文档尚无内容行：以空文档作为初始内容，首次编辑即落盘。
        const base = result ?? emptyContent(page.id);
        // 正文 JSON 运行时校验：损坏时不进编辑器，转入损坏处理面板（R003 阶段 4）。
        const parsed = parseDocumentContent(base.contentJson);
        if (!parsed.ok) {
          writeCorruptedDiagnostic({
            pageId: page.id,
            raw: parsed.raw,
            error: parsed.error.message,
            detectedAt: Date.now(),
          });
          setCorrupted({ raw: parsed.raw, error: parsed.error.message });
          setContent(base);
          return;
        }
        // 恢复缓冲比已落盘正文更新：提示用户恢复上次未保存的编辑。
        const record = readRecovery(page.id);
        if (record && record.timestamp > base.updatedAt) {
          setRecovery(record);
        }
        setContent(base);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [view, page?.id, page?.kind]);

  const onEditorReady = useCallback((instance: Editor | null) => {
    setEditor(instance);
    if (instance && !instance.isDestroyed && pendingExitToBodyRef.current) {
      pendingExitToBodyRef.current = false;
      instance.chain().focus("start").run();
    }
  }, []);

  const onSaveStateChange = useCallback((state: SaveState) => {
    setSaveState(state);
  }, []);

  const onRegisterRetry = useCallback((retry: () => void) => {
    retrySaveRef.current = retry;
  }, []);

  // 应用恢复缓冲：以恢复内容重建编辑器，并由编辑器立即执行一次保存；
  // 恢复缓冲本身在保存成功后由协调器清除（期间重复提示可接受）。
  const applyRecovery = useCallback(() => {
    if (!recovery || !content) return;
    setContent({
      ...content,
      contentJson: recovery.contentJson,
      updatedAt: recovery.timestamp,
    });
    setRecovery(null);
    setContentEpoch((e) => e + 1);
  }, [recovery, content]);

  const discardRecoveryPrompt = useCallback(() => {
    if (page) discardRecovery(page.id);
    setRecovery(null);
  }, [page]);

  // 损坏正文：尝试恢复（sanitize 尽力保留合法内容），重建编辑器并立即保存。
  const recoverCorrupted = useCallback(() => {
    if (!corrupted || !content) return;
    const sanitized = sanitizeDocumentContent(corrupted.raw);
    setCorrupted(null);
    setContent({ ...content, contentJson: sanitized, updatedAt: Date.now() });
    setContentEpoch((e) => e + 1);
  }, [corrupted, content]);

  // 损坏正文：导出原始 JSON 供排查或外部修复。
  const exportCorrupted = useCallback(() => {
    if (!corrupted || !page) return;
    const blob = new Blob([JSON.stringify(corrupted.raw, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${page.title || "无标题"}.corrupted.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [corrupted, page]);

  // 损坏正文：以空白文档覆盖（原始 JSON 已保留在诊断记录中，可先导出）。
  const blankCorrupted = useCallback(async () => {
    if (!page) return;
    await contentRepository.save(
      page.id,
      { type: "doc", content: [{ type: "paragraph" }] },
      "",
    );
    clearCorruptedDiagnostic(page.id);
    setCorrupted(null);
    setContent(emptyContent(page.id));
    setContentEpoch((e) => e + 1);
  }, [page]);

  // 文档在主区域完成渲染后记录最近浏览时间（仅打开，不含搜索预览）。
  useEffect(() => {
    if (view === "document" && page?.kind === "document" && content) {
      void markOpened(page.id);
    }
    // content 随页面加载一次性落地，加载完成时触发一次即可。
  }, [view, page?.id, page?.kind, content, markOpened]);

  // 切换/新建文档时旧编辑器先销毁、onEditorReady(null) 后落地，
  // 期间状态里仍是已销毁实例，调用其 API 会抛错，需以 isDestroyed 兜底。
  const liveEditor = editor !== null && !editor.isDestroyed ? editor : null;

  const toggleTheme = () => {
    void setTheme(preferences.theme === "dark" ? "light" : "dark");
  };

  const exportMarkdown = () => {
    if (!editor || !page) return;
    const markdown = jsonToMarkdown(editor.getJSON());
    // 通过临时 Blob + 隐藏 <a download> 触发浏览器下载，无需任何服务端参与
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

  // 知识库会话切换中/失败（R003 阶段 2）：不渲染任何基于旧会话数据的视图。
  if (workspaceStatus === "loading") {
    return (
      <main className="main">
        <div className="main-empty">正在加载知识库…</div>
      </main>
    );
  }
  if (workspaceStatus === "error") {
    return (
      <main className="main">
        <div className="app-error" role="alert">
          <p>{workspaceError ?? "知识库加载失败，请重试。"}</p>
          <button type="button" className="app-error__retry" onClick={retryLoad}>
            重试
          </button>
        </div>
      </main>
    );
  }

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
          <IconMenu />
        </button>
        <span className="topbar__title" title={page?.title || "无标题"}>
          {page?.title || "无标题"}
        </span>
        <div className="topbar__spacer" />
        {isDocument && liveEditor && (
          <>
            <SaveStateIndicator state={saveState} onRetry={() => retrySaveRef.current?.()} />
            <WordCount editor={liveEditor} />
          </>
        )}
        {isDocument && (
          <button
            type="button"
            className="icon-button"
            aria-label={page.favoriteAt === null ? "收藏文档" : "取消收藏文档"}
            aria-pressed={page.favoriteAt !== null}
            title={page.favoriteAt === null ? "收藏" : "取消收藏"}
            onClick={() => void togglePageFavorite(page.id)}
          >
            {page.favoriteAt === null ? <IconStar /> : <IconStarFilled />}
          </button>
        )}
        {isDocument && (
          <button
            type="button"
            className="icon-button"
            aria-label="版本历史"
            title="版本历史"
            aria-pressed={versionsOpen}
            disabled={!liveEditor}
            onClick={() => setVersionsOpen((v) => !v)}
          >
            <IconClock />
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
          <IconExport />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="目录"
          aria-pressed={tocOpen}
          disabled={!liveEditor}
          onClick={() => setTocOpen((v) => !v)}
        >
          <IconList />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={preferences.theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
          onClick={toggleTheme}
        >
          {preferences.theme === "dark" ? <IconSun /> : <IconMoon />}
        </button>
      </header>

      {isDocument ? (
        <div className="doc-layout">
          {liveEditor && <FormatToolbar editor={liveEditor} />}
          <div className="doc-main">
            <div className="doc-scroll">
              {recovery && (
                <div className="recovery-banner" role="status">
                  <span className="recovery-banner__text">
                    检测到上次未保存的编辑内容。
                  </span>
                  <Button variant="primary" onClick={applyRecovery}>
                    恢复
                  </Button>
                  <Button variant="ghost" onClick={discardRecoveryPrompt}>
                    丢弃
                  </Button>
                </div>
              )}
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
                  onExitToBody={() => {
                    if (liveEditor) {
                      liveEditor.chain().focus("start").run();
                    } else {
                      // 正文仍在加载：等 onEditorReady 后再聚焦首行。
                      pendingExitToBodyRef.current = true;
                    }
                  }}
                />
                <TagPicker pageId={page.id} />
              </div>
              <div className="doc-body">
                {corrupted ? (
                  <div className="corrupted-panel" role="alert">
                    <h2 className="corrupted-panel__title">文档内容损坏</h2>
                    <p className="corrupted-panel__hint">
                      正文数据未通过校验，编辑器已停止加载以防内容进一步损坏。
                      原始数据已保留在本地诊断记录中。
                    </p>
                    <div className="corrupted-panel__actions">
                      <Button variant="primary" onClick={recoverCorrupted}>
                        尝试恢复
                      </Button>
                      <Button variant="secondary" onClick={exportCorrupted}>
                        导出原始 JSON
                      </Button>
                      <Button
                        variant="danger"
                        onClick={() => void blankCorrupted()}
                      >
                        创建空白副本
                      </Button>
                    </div>
                  </div>
                ) : content ? (
                  <DocumentEditor
                    // contentEpoch 变化（应用恢复）时强制重建编辑器以加载恢复内容。
                    key={`${page.id}:${contentEpoch}`}
                    pageId={page.id}
                    initialContent={content.contentJson}
                    onEditorReady={onEditorReady}
                    onSaveStateChange={onSaveStateChange}
                    onRegisterRetry={onRegisterRetry}
                    restoreRequestId={contentEpoch}
                  />
                ) : (
                  <p className="doc-placeholder">正在加载文档…</p>
                )}
              </div>
            </div>
            {tocOpen && liveEditor && <TocPanel editor={liveEditor} />}
          </div>
          {versionsOpen && liveEditor && (
            <VersionPanel
              pageId={page.id}
              editor={liveEditor}
              onClose={() => setVersionsOpen(false)}
            />
          )}
        </div>
      ) : (
        <div className="main-empty">从左侧选择或新建一篇文档。</div>
      )}
    </main>
  );
}
