/**
 * @file 主区组件：应用右侧的内容分发与文档编辑宿主。
 * 依据 AppState 中的 `view` 路由渲染开始首页 / 最近浏览 / 收藏 /
 * 知识库首页 / 文档编辑区（R002 的 48px 顶栏 + 工具栏 + 780px 正文布局在此组装），
 * 并承担文档内容的加载、最近浏览记录、主题切换与 Markdown 导出。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import type { DocumentContent } from "../domain/types";
import { INITIAL_CONTENT_VERSION_TOKEN } from "../domain/types";
import { exportDocumentMarkdown } from "../application/markdown/documentExport";
import { useAppServices } from "../state/AppServicesProvider";
import type { DocumentEditorController } from "../application/services/DocumentEditorController";
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
import {
  useWorkspaceCommands,
  useWorkspaceData,
} from "../state/WorkspaceSessionContext";
import {
  useNavigationCommands,
  useNavigationState,
} from "../state/NavigationContext";
import { usePreferences } from "../state/PreferencesContext";
import { useOverlay } from "../state/OverlayContext";
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
  IconExport,
  IconHistory,
  IconList,
  IconMenu,
  IconMoon,
  IconStar,
  IconStarFilled,
  IconSun,
} from "./ui/icons";

/** 新建文档的初始空内容（尚无 IndexedDB 内容行时使用）。 */
function emptyContent(pageId: string, workspaceId: string): DocumentContent {
  return {
    pageId,
    workspaceId,
    contentJson: { type: "doc", content: [{ type: "paragraph" }] },
    textSnapshot: "",
    // 尚无正文记录：乐观锁起点为初始版本令牌（空串），首次保存由仓储
    // 生成首个令牌（R005 阶段 3；R004 阶段 7 乐观锁语义不变）。
    version: INITIAL_CONTENT_VERSION_TOKEN,
    updatedAt: Date.now(),
  };
}

/** 主栏：按视图渲染开始首页 / 知识库首页 / 文档编辑区。 */
export function MainArea() {
  const services = useAppServices();
  const { pages, workspaceStatus, workspaceError } = useWorkspaceData();
  const {
    renamePage,
    markOpened,
    togglePageFavorite,
    createDocumentWithContent,
    retryLoad,
  } = useWorkspaceCommands();
  const { view, selectedPageId, titleFocusPageId } = useNavigationState();
  const { clearTitleFocus, openDocument } = useNavigationCommands();
  const { preferences, setTheme } = usePreferences();
  const { openTreeDrawer } = useOverlay();
  const page = pages.find((p) => p.id === selectedPageId) ?? null;
  const [content, setContent] = useState<DocumentContent | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [editorController, setEditorController] =
    useState<DocumentEditorController | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>({
    status: "saved",
    savedAt: null,
    errorKind: null,
  });
  // 其他标签页保存了当前编辑文档且本地有未保存修改（R004 §7.2）：
  // 提前提示冲突，与乐观锁冲突 UI（errorKind: conflict）汇合为同一面板。
  const [remoteConflict, setRemoteConflict] = useState(false);
  // 未落盘编辑的恢复提示（R003 §1.4）：恢复缓冲比 IndexedDB 正文更新时出现。
  const [recovery, setRecovery] = useState<DocumentRecoveryRecord | null>(null);
  // 正文 JSON 校验失败（R003 阶段 4）：不渲染编辑器，显示损坏处理面板。
  const [corrupted, setCorrupted] = useState<{
    raw: unknown;
    error: string;
  } | null>(null);
  // 应用恢复后递增：强制编辑器以恢复内容重建，并触发一次立即保存。
  const [contentEpoch, setContentEpoch] = useState(0);
  const retrySaveRef = useRef<(() => void) | null>(null);
  // 冲突处理动作（R004 阶段 7）：由 DocumentEditor 注册「强制覆盖」。
  const conflictActionsRef = useRef<{ forceOverwrite(): void } | null>(null);
  // 标题 Enter/ArrowDown 时正文编辑器可能尚未就绪；就绪后补一次聚焦首行。
  const pendingExitToBodyRef = useRef(false);
  // 供同步频道订阅回调读取最新值（订阅本身保持稳定引用）。
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;
  const pageRef = useRef(page);
  pageRef.current = page;

  useEffect(() => {
    // cancelled 防止竞态：快速切换页面时旧请求晚到不得覆盖新页面的内容
    let cancelled = false;
    setContent(null);
    setRecovery(null);
    setCorrupted(null);
    setRemoteConflict(false);
    pendingExitToBodyRef.current = false;
    if (view === "document" && page?.kind === "document") {
      void services.queries.document.getContent(page.id).then((result) => {
        if (cancelled) return;
        // 新建文档尚无内容行：以空文档作为初始内容，首次编辑即落盘。
        const base = result ?? emptyContent(page.id, page.workspaceId);
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
  }, [view, page?.id, page?.kind, services]);

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

  const onRegisterConflictActions = useCallback(
    (actions: { forceOverwrite(): void } | null) => {
      conflictActionsRef.current = actions;
    },
    [],
  );

  /**
   * 冲突处理①「重新载入磁盘版本」（R004 阶段 7）：丢弃本地未保存修改，
   * 以磁盘最新正文重建编辑器（contentEpoch +1 → 协调器随之重建，
   * 乐观锁起点更新为最新 version）；同时清理恢复缓冲，避免旧内容再次提示。
   * 其他标签页保存当前文档且本地干净时，也经本函数自动重载（§7.2）。
   */
  const reloadFromDisk = useCallback(async () => {
    const current = pageRef.current;
    if (!current) return;
    const latest = await services.queries.document.getContent(current.id);
    if (!latest || pageRef.current?.id !== current.id) return;
    const parsed = parseDocumentContent(latest.contentJson);
    if (!parsed.ok) return;
    discardRecovery(current.id);
    services.queries.search.syncText(
      current.id,
      latest.textSnapshot,
      latest.updatedAt,
    );
    setRemoteConflict(false);
    setContent({ ...latest, contentJson: parsed.value });
    setContentEpoch((e) => e + 1);
  }, [services]);

  /**
   * 冲突处理②「保留当前内容并另存副本」：当前编辑器内容经既有
   * createDocumentWithContent 原子创建为新文档并打开（不新造写入路径）；
   * 本文档保持冲突状态，用户可继续处理。
   */
  const saveConflictCopy = useCallback(async () => {
    if (!page || !editorController) return;
    const snapshot = editorController.getSnapshot();
    const copy = await createDocumentWithContent({
      workspaceId: page.workspaceId,
      parentId: page.parentId,
      title: `${page.title || "无标题"}（副本）`,
      contentJson: snapshot.contentJson,
      textSnapshot: snapshot.textSnapshot,
    });
    if (copy) await openDocument(copy.id);
  }, [page, editorController, createDocumentWithContent, openDocument]);

  /** 冲突处理④「复制当前内容」：编辑器纯文本进剪贴板，供人工合并。 */
  const copyConflictContent = useCallback(() => {
    const live = editor !== null && !editor.isDestroyed ? editor : null;
    if (!live) return;
    void navigator.clipboard?.writeText(live.getText()).catch(() => {
      // 剪贴板不可用（权限/非安全上下文）时静默失败，不影响主流程。
    });
  }, [editor]);

  // 其他标签页的正文落盘事件（R004 §7.2）：当前编辑文档——本地干净自动
  // 重载、有未保存修改提示冲突；非当前文档——增量刷新搜索索引文本。
  // 自己保存产生的事件已被频道按来源 tabId 过滤，不会回声。
  useEffect(() => {
    return services.syncChannel.subscribe((event) => {
      if (event.type !== "content-saved") return;
      const current = pageRef.current;
      if (
        current &&
        current.kind === "document" &&
        event.pageId === current.id
      ) {
        if (saveStateRef.current.status === "saved") {
          void reloadFromDisk();
        } else {
          setRemoteConflict(true);
        }
        return;
      }
      void services.queries.document
        .getContent(event.pageId)
        .then((latest) => {
          if (latest) {
            services.queries.search.syncText(
              event.pageId,
              latest.textSnapshot,
              latest.updatedAt,
            );
          }
        })
        .catch(() => {
          // 索引刷新失败不影响编辑主流程。
        });
    });
  }, [services, reloadFromDisk]);

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
  // 经文档命令服务原子覆盖并同步搜索索引（R004 阶段 3 / R005 批次 2）。
  const blankCorrupted = useCallback(async () => {
    if (!page) return;
    await services.commands.document.replaceContent({
      pageId: page.id,
      contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      textSnapshot: "",
    });
    clearCorruptedDiagnostic(page.id);
    setCorrupted(null);
    setContent(emptyContent(page.id, page.workspaceId));
    setContentEpoch((e) => e + 1);
  }, [page, services]);

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

  const exportMarkdown = async () => {
    if (!liveEditor || !page) return;
    // R005 阶段 4B：导出经 MarkdownCodec 编排——含图片/附件时产出
    // 含资源的 ZIP 包（标题.md + assets/…），不再静默丢弃资源节点；
    // 无资源时维持单 .md 导出（无 Frontmatter，行为同现状）。
    const result = await exportDocumentMarkdown({
      title: page.title || "无标题",
      document: liveEditor.getJSON(),
      assetAccess: services.assets.access,
    });
    // 导出入口暂无 toast 反馈通道：有损转换明细先经 console.warn 暴露，
    // 后续批次有统一通知通道后再接上「本次导出含有损转换」提示。
    if (result.lossy) {
      console.warn(
        `本次导出含有损转换（${result.unsupported.length} 项）：`,
        result.unsupported,
      );
    }
    // 通过临时 Blob + 隐藏 <a download> 触发浏览器下载，无需任何服务端参与
    const blob =
      result.kind === "zip"
        ? new Blob([result.data.buffer as ArrayBuffer], {
            type: "application/zip",
          })
        : new Blob([result.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = result.fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const isDocument = page?.kind === "document";
  // 乐观锁冲突（本地保存撞版本）或其他标签页保存了当前文档且本地 dirty：
  // 两种来源汇合为同一冲突面板（R004 阶段 7）。
  const conflictVisible =
    isDocument &&
    content !== null &&
    (remoteConflict ||
      (saveState.status === "error" && saveState.errorKind === "conflict"));

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
          <button
            type="button"
            className="app-error__retry"
            onClick={retryLoad}
          >
            重试
          </button>
        </div>
      </main>
    );
  }

  if (view === "start") {
    return (
      <main className="main">
        <StartPage />
      </main>
    );
  }
  if (view === "recent") {
    return (
      <main className="main">
        <RecentPage />
      </main>
    );
  }
  if (view === "favorites") {
    return (
      <main className="main">
        <FavoritesPage />
      </main>
    );
  }
  if (view === "workspace") {
    return (
      <main className="main">
        <WorkspaceHome />
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
          onClick={openTreeDrawer}
        >
          <IconMenu />
        </button>
        <span className="topbar__title" title={page?.title || "无标题"}>
          {page?.title || "无标题"}
        </span>
        <div className="topbar__spacer" />
        {isDocument && liveEditor && (
          <>
            <SaveStateIndicator
              state={saveState}
              onRetry={() => retrySaveRef.current?.()}
            />
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
            <IconHistory />
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label="导出 Markdown"
          title="导出 Markdown"
          disabled={!liveEditor}
          onClick={() => void exportMarkdown()}
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
          aria-label={
            preferences.theme === "dark" ? "切换到浅色主题" : "切换到深色主题"
          }
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
              {conflictVisible && (
                <div className="recovery-banner conflict-banner" role="alert">
                  <span className="recovery-banner__text">
                    本文档已在其他标签页被修改，与当前未保存的编辑冲突。
                  </span>
                  <Button
                    variant="primary"
                    onClick={() => void reloadFromDisk()}
                  >
                    重新载入
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => void saveConflictCopy()}
                  >
                    另存副本
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => conflictActionsRef.current?.forceOverwrite()}
                  >
                    强制覆盖
                  </Button>
                  <Button variant="ghost" onClick={copyConflictContent}>
                    复制当前内容
                  </Button>
                </div>
              )}
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
                    initialVersion={content.version}
                    onEditorReady={onEditorReady}
                    onSaveStateChange={onSaveStateChange}
                    onRegisterRetry={onRegisterRetry}
                    onRegisterConflictActions={onRegisterConflictActions}
                    restoreRequestId={contentEpoch}
                    onControllerReady={setEditorController}
                  />
                ) : (
                  <p className="doc-placeholder">正在加载文档…</p>
                )}
              </div>
            </div>
            {tocOpen && liveEditor && <TocPanel editor={liveEditor} />}
          </div>
          {versionsOpen && editorController && (
            <VersionPanel
              pageId={page.id}
              controller={editorController}
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
