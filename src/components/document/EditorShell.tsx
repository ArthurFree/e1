/**
 * @file 文档编辑区外框（自 MainArea 提取，行为不变）。
 * R002 的 48px 顶栏 + 常驻工具栏 + 780px 正文布局在此组装：顶栏动作、
 * 各类提示条（Adoption / 兼容性 / 有损保存 / 冲突 / 恢复）、文档标题与
 * 标签、目录与版本历史面板；正文本体由 children 插槽提供。
 */

import { useState, type ReactNode } from "react";
import type { Editor } from "@tiptap/core";
import type { Page } from "../../domain/types";
import { useAppServices } from "../../state/AppServicesProvider";
import { useWorkspaceCommands } from "../../state/WorkspaceSessionContext";
import {
  useNavigationCommands,
  useNavigationState,
} from "../../state/NavigationContext";
import { usePreferences } from "../../state/PreferencesContext";
import { useOverlay } from "../../state/OverlayContext";
import type { DocumentEditorController } from "../../application/services/DocumentEditorController";
import { Button } from "../ui/Button";
import { TitleEditor } from "../TitleEditor";
import { TagPicker } from "../TagPicker";
import { VersionPanel } from "../VersionPanel";
import { FormatToolbar } from "../editor/FormatToolbar";
import { TocPanel } from "../editor/TocPanel";
import { WordCount } from "../editor/WordCount";
import { SaveStateIndicator } from "../editor/SaveStateIndicator";
import {
  IconAlertTriangle,
  IconExport,
  IconHistory,
  IconList,
  IconMenu,
  IconMoon,
  IconStar,
  IconStarFilled,
  IconSun,
} from "../ui/icons";
import { CompatibilityDetailDialog } from "./CompatibilityDetailDialog";
import type { DocumentSession } from "./hooks/useDocumentSession";
import type { DocumentCompatibility } from "./hooks/useDocumentCompatibility";
import type { DocumentConflict } from "./hooks/useDocumentConflict";

interface EditorShellProps {
  /** 当前页面；非文档类型（分组）或未选中时只渲染顶栏与空态。 */
  page: Page | null;
  session: DocumentSession;
  compatibility: DocumentCompatibility;
  conflict: DocumentConflict;
  /** 存活的编辑器实例（已销毁实例由调用方过滤为 null）。 */
  editor: Editor | null;
  editorController: DocumentEditorController | null;
  /** 标题按 Enter/ArrowDown 退出到正文首行。 */
  onExitTitleToBody(): void;
  onExportMarkdown(): void;
  /** 正文区：编辑器 / 损坏面板 / 错误块 / 加载占位。 */
  children: ReactNode;
}

export function EditorShell({
  page,
  session,
  compatibility,
  conflict,
  editor,
  editorController,
  onExitTitleToBody,
  onExportMarkdown,
  children,
}: EditorShellProps) {
  const services = useAppServices();
  const { renamePage, togglePageFavorite, refreshCurrentWorkspace } =
    useWorkspaceCommands();
  const { titleFocusPageId } = useNavigationState();
  const { clearTitleFocus, showWorkspaceHome } = useNavigationCommands();
  const { preferences, setTheme } = usePreferences();
  const { openTreeDrawer } = useOverlay();
  const [tocOpen, setTocOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);

  const { access, markdown } = compatibility;
  const { saveState } = conflict;
  const isDocument = page?.kind === "document";
  // 文档是否真实持久化（R006-C3 FR-22）：false（技术验证模式）时编辑器
  // 不启动协调器，顶栏以固定文案取代保存状态指示。
  const persistenceEnabled = services.capabilities.documentPersistence;

  const toggleTheme = () => {
    void setTheme(preferences.theme === "dark" ? "light" : "dark");
  };

  // R007 阶段 3 §3.4：「源文件已删除」错误块的重新扫描——失效扫描缓存
  // 并刷新页面树/标签镜像（同 WorkspaceHome 的 rescanVault 口径）。
  const rescanExternalDeleted = async () => {
    if (!page) return;
    await services.vaultMaintenance?.rescan(page.workspaceId);
    await refreshCurrentWorkspace();
  };

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
        {isDocument && editor && (
          <>
            {persistenceEnabled ? (
              <SaveStateIndicator
                state={saveState}
                onRetry={conflict.retrySave}
              />
            ) : (
              // FR-22：无持久化能力的平台不启动协调器，以固定文案取代
              // 保存状态，防止用户误以为编辑已写回磁盘。
              <span className="save-state" role="status">
                技术验证模式 · 当前修改不会写回磁盘
              </span>
            )}
            <WordCount editor={editor} />
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
        {isDocument && services.operations.revision.read && (
          <button
            type="button"
            className="icon-button"
            aria-label="版本历史"
            title="版本历史"
            aria-pressed={versionsOpen}
            disabled={!editor || !persistenceEnabled || access === "read-only"}
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
          disabled={!editor}
          onClick={onExportMarkdown}
        >
          <IconExport />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="目录"
          aria-pressed={tocOpen}
          disabled={!editor}
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
          {editor && access === "editable" && <FormatToolbar editor={editor} />}
          <div className="doc-main">
            <div className="doc-scroll">
              {compatibility.identityAdoptionVisible && (
                <div
                  className="recovery-banner compatibility-banner"
                  role="alert"
                >
                  <IconAlertTriangle size={16} />
                  <span className="recovery-banner__text">
                    这篇 Markdown 尚未建立 E1 稳定笔记身份。启用编辑后，E1 会在
                    Frontmatter 中加入一个稳定
                    id，用于未来识别移动、重命名后的同一篇笔记。不会修改正文内容。
                  </span>
                  <Button
                    variant="secondary"
                    onClick={compatibility.keepReadOnly}
                  >
                    保持只读
                  </Button>
                  <Button
                    variant="primary"
                    onClick={compatibility.allowIdentityAdoption}
                  >
                    启用编辑
                  </Button>
                </div>
              )}
              {markdown.lossy && (
                // FR-20/§36.2：Markdown 兼容性保护提示条——默认只读，
                // 「允许本次编辑」仅当前会话生效，重开重新判断（§28.2）。
                <div
                  className="recovery-banner compatibility-banner"
                  role="alert"
                >
                  <IconAlertTriangle size={16} />
                  <span className="recovery-banner__text">
                    {access === "read-only"
                      ? "当前 Markdown 包含 E1 暂不完全支持的格式，为避免修改后破坏原始文件，已以只读模式打开。"
                      : "当前 Markdown 包含 E1 暂不完全支持的格式；已允许本次编辑（仅当前会话生效），重新打开后会重新判断。"}
                  </span>
                  <Button
                    variant="secondary"
                    onClick={compatibility.openDetail}
                  >
                    查看详情
                  </Button>
                  {access === "read-only" && (
                    <Button
                      variant="primary"
                      onClick={compatibility.allowLossyEditing}
                    >
                      允许本次编辑
                    </Button>
                  )}
                </div>
              )}
              {saveState.status === "error" &&
                saveState.errorKind === "lossy" && (
                  <div
                    className="recovery-banner compatibility-banner"
                    role="alert"
                  >
                    <IconAlertTriangle size={16} />
                    <span className="recovery-banner__text">
                      当前内容包含 Markdown 无法完整表达的格式，自动保存已暂停。
                    </span>
                    <Button
                      variant="primary"
                      onClick={() => {
                        compatibility.approveLossyOutput();
                        conflict.retrySave();
                      }}
                    >
                      仍然保存
                    </Button>
                  </div>
                )}
              {conflict.externalReloadNotice && (
                // R007 阶段 3 §3.4：外部修改/移动后自动重载的轻量提示，
                // 约 5 秒自动消失，也可手动关闭。
                <div className="recovery-banner" role="status">
                  <span className="recovery-banner__text">
                    文件已由其他程序更新，已自动重新载入。
                  </span>
                  <Button
                    variant="ghost"
                    onClick={conflict.dismissExternalReloadNotice}
                  >
                    关闭
                  </Button>
                </div>
              )}
              {conflict.externalDeleted === "dirty" && (
                // R007 阶段 3 §3.4：源文件被外部删除且本地有未保存修改——
                // 保留编辑器内存，提供另存副本/复制内容出口。
                <div className="recovery-banner conflict-banner" role="alert">
                  <IconAlertTriangle size={16} />
                  <span className="recovery-banner__text">
                    源文件已被其他程序删除，当前编辑内容仍保留在内存中。
                  </span>
                  <Button
                    variant="primary"
                    onClick={() => void conflict.saveConflictCopy()}
                  >
                    另存副本
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={conflict.copyConflictContent}
                  >
                    复制当前内容
                  </Button>
                </div>
              )}
              {conflict.conflictVisible && (
                <div className="recovery-banner conflict-banner" role="alert">
                  <span className="recovery-banner__text">
                    {services.capabilities.localDirectory
                      ? "这篇笔记已在 E1 之外发生修改，为了避免覆盖外部修改，自动保存已暂停。"
                      : "本文档已在其他标签页被修改，与当前未保存的编辑冲突。"}
                  </span>
                  <Button
                    variant="primary"
                    onClick={() => void conflict.reloadFromDisk()}
                  >
                    重新载入
                  </Button>
                  {!services.capabilities.localDirectory && (
                    <Button
                      variant="secondary"
                      onClick={() => void conflict.saveConflictCopy()}
                    >
                      另存副本
                    </Button>
                  )}
                  <Button variant="secondary" onClick={conflict.forceOverwrite}>
                    强制覆盖
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={conflict.copyConflictContent}
                  >
                    复制当前内容
                  </Button>
                </div>
              )}
              {session.recovery && (
                <div className="recovery-banner" role="status">
                  <span className="recovery-banner__text">
                    检测到上次未保存的编辑内容。
                  </span>
                  <Button variant="primary" onClick={session.applyRecovery}>
                    恢复
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={session.discardRecoveryPrompt}
                  >
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
                  onExitToBody={onExitTitleToBody}
                />
                <TagPicker pageId={page.id} />
              </div>
              <div className="doc-body">
                {conflict.externalDeleted === "clean" ? (
                  // R007 阶段 3 §3.4：源文件被外部删除且本地无未保存修改——
                  // 正文区替换为错误块（样式复用打开链路的 content-error）。
                  <div className="content-error" role="alert">
                    <div className="content-error__icon" aria-hidden="true">
                      <IconAlertTriangle size={20} />
                    </div>
                    <h2 className="content-error__title">源文件已被删除</h2>
                    <p className="content-error__description">
                      这篇 Markdown
                      已被其他程序从知识库目录中删除。你可以重新扫描知识库，或返回知识库首页。
                    </p>
                    <div className="content-error__actions">
                      <Button
                        variant="primary"
                        onClick={() => void rescanExternalDeleted()}
                      >
                        重新扫描知识库
                      </Button>
                      <Button variant="secondary" onClick={showWorkspaceHome}>
                        返回知识库
                      </Button>
                    </div>
                  </div>
                ) : (
                  children
                )}
              </div>
            </div>
            {tocOpen && editor && <TocPanel editor={editor} />}
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
      {compatibility.detailOpen && (
        // FR-20 §28.1：不支持语法明细弹层（Escape/遮罩关闭，复用 ui/Dialog）。
        <CompatibilityDetailDialog
          compatibility={markdown}
          onClose={compatibility.closeDetail}
        />
      )}
    </main>
  );
}
