/**
 * @file 文档视图编排（自 MainArea 提取，行为不变）。
 * 装配三个文档 hook（会话 / 打开状态 / 冲突）与编辑器实例生命周期，
 * 承担最近浏览记录、Markdown 导出与「重新扫描知识库」，并决定正文区
 * 渲染哪一种形态（编辑器 / 损坏面板 / 错误块 / 加载占位）；
 * 顶栏、提示条、标题与标签等外框由 EditorShell 渲染。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Editor } from "@tiptap/core";
import type { DocumentEditorController } from "../../application/services/DocumentEditorController";
import { useAppServices } from "../../state/AppServicesProvider";
import {
  useWorkspaceCommands,
  useWorkspaceData,
} from "../../state/WorkspaceSessionContext";
import {
  useNavigationCommands,
  useNavigationState,
} from "../../state/NavigationContext";
import { Button } from "../ui/Button";
import { DocumentEditor } from "../editor/DocumentEditor";
import { ContentErrorBlock } from "./ContentErrorBlock";
import { EditorShell } from "./EditorShell";
import { exportMarkdownFile } from "./exportMarkdown";
import { useDocumentSession } from "./hooks/useDocumentSession";
import { useDocumentCompatibility } from "./hooks/useDocumentCompatibility";
import { useDocumentConflict } from "./hooks/useDocumentConflict";

export function DocumentScreen() {
  const services = useAppServices();
  const { pages } = useWorkspaceData();
  const { markOpened, refreshCurrentWorkspace } = useWorkspaceCommands();
  const { selectedPageId } = useNavigationState();
  const { showWorkspaceHome } = useNavigationCommands();
  const page = pages.find((p) => p.id === selectedPageId) ?? null;

  const [editor, setEditor] = useState<Editor | null>(null);
  const [editorController, setEditorController] =
    useState<DocumentEditorController | null>(null);
  // 标题 Enter/ArrowDown 时正文编辑器可能尚未就绪；就绪后补一次聚焦首行。
  const pendingExitToBodyRef = useRef(false);
  const pageRef = useRef(page);
  pageRef.current = page;

  const session = useDocumentSession(page);
  const { content, contentEpoch, retryContentLoad } = session;
  const compatibility = useDocumentCompatibility({
    pageId: page?.id ?? null,
    sessionKey: session.sessionKey,
    opened: session.opened,
  });
  const conflict = useDocumentConflict({
    page,
    sessionKey: session.sessionKey,
    contentLoaded: content !== null,
    editor,
    editorController,
    onContentReloaded: session.replaceLoadedContent,
  });

  // 会话切换时清除待聚焦标记，避免新文档意外跳到正文首行。
  useEffect(() => {
    pendingExitToBodyRef.current = false;
  }, [session.sessionKey]);

  const onEditorReady = useCallback((instance: Editor | null) => {
    setEditor(instance);
    if (instance && !instance.isDestroyed && pendingExitToBodyRef.current) {
      pendingExitToBodyRef.current = false;
      instance.chain().focus("start").run();
    }
  }, []);

  // 切换/新建文档时旧编辑器先销毁、onEditorReady(null) 后落地，
  // 期间状态里仍是已销毁实例，调用其 API 会抛错，需以 isDestroyed 兜底。
  const liveEditor = editor !== null && !editor.isDestroyed ? editor : null;

  const pageId = page?.id ?? null;
  const pageKind = page?.kind ?? null;
  // 文档在主区域完成渲染后记录最近浏览时间（仅打开，不含搜索预览）。
  useEffect(() => {
    if (pageId && pageKind === "document" && content) {
      void markOpened(pageId);
    }
    // content 随页面加载一次性落地，加载完成时触发一次即可。
  }, [pageId, pageKind, content, markOpened]);

  /**
   * 重新扫描知识库（FR-23/FR-26）：vaultMaintenance port 使扫描缓存失效
   * 并重新扫描 → 刷新页面树/标签镜像 → 重试正文打开（被外部程序移回的
   * 文件可立即恢复阅读）。§34.1：只支持用户主动刷新，不做文件监听。
   */
  const canRescan =
    services.capabilities.localDirectory &&
    services.vaultMaintenance !== undefined;
  const rescanVault = useCallback(async () => {
    const current = pageRef.current;
    const maintenance = services.vaultMaintenance;
    if (!maintenance || !current) return;
    await maintenance.rescan(current.workspaceId);
    await refreshCurrentWorkspace();
    retryContentLoad();
  }, [services, refreshCurrentWorkspace, retryContentLoad]);

  const exportMarkdown = useCallback(() => {
    if (!liveEditor || !page) return;
    void exportMarkdownFile({
      title: page.title || "无标题",
      document: liveEditor.getJSON(),
      assetAccess: services.assets.access,
    });
  }, [liveEditor, page, services]);

  const onExitTitleToBody = useCallback(() => {
    if (liveEditor) {
      liveEditor.chain().focus("start").run();
    } else {
      // 正文仍在加载：等 onEditorReady 后再聚焦首行。
      pendingExitToBodyRef.current = true;
    }
  }, [liveEditor]);

  let body: ReactNode = null;
  if (page && page.kind === "document") {
    if (session.contentError) {
      body = (
        <ContentErrorBlock
          error={session.contentError}
          onRetry={retryContentLoad}
          onRescan={canRescan ? () => void rescanVault() : undefined}
          onClose={showWorkspaceHome}
        />
      );
    } else if (session.corrupted) {
      body = (
        <div className="corrupted-panel" role="alert">
          <h2 className="corrupted-panel__title">文档内容损坏</h2>
          <p className="corrupted-panel__hint">
            正文数据未通过校验，编辑器已停止加载以防内容进一步损坏。
            原始数据已保留在本地诊断记录中。
          </p>
          <div className="corrupted-panel__actions">
            <Button variant="primary" onClick={session.recoverCorrupted}>
              尝试恢复
            </Button>
            <Button variant="secondary" onClick={session.exportCorrupted}>
              导出原始 JSON
            </Button>
            <Button
              variant="danger"
              onClick={() => void session.blankCorrupted()}
            >
              创建空白副本
            </Button>
          </div>
        </div>
      );
    } else if (content) {
      body = (
        <DocumentEditor
          // contentEpoch 变化（应用恢复）时强制重建编辑器以加载恢复内容。
          key={`${page.id}:${contentEpoch}`}
          pageId={page.id}
          initialContent={content.contentJson}
          initialVersion={content.version}
          onEditorReady={onEditorReady}
          onSaveStateChange={conflict.onSaveStateChange}
          onRegisterRetry={conflict.onRegisterRetry}
          onRegisterConflictActions={conflict.onRegisterConflictActions}
          restoreRequestId={contentEpoch}
          onControllerReady={setEditorController}
          access={compatibility.access}
        />
      );
    } else {
      body = <p className="doc-placeholder">正在加载文档…</p>;
    }
  }

  return (
    <EditorShell
      page={page}
      session={session}
      compatibility={compatibility}
      conflict={conflict}
      editor={liveEditor}
      editorController={editorController}
      onExitTitleToBody={onExitTitleToBody}
      onExportMarkdown={exportMarkdown}
    >
      {body}
    </EditorShell>
  );
}
