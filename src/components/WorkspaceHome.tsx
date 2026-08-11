/**
 * @file 知识库首页：选中知识库时的落地视图（view === "workspace"）。
 * 含知识库头部（图标 / 名称 / 描述 / 收藏）、文档数与总字数统计、
 * 新建文档 / 分组主操作，以及完整目录概览（可折叠分组，仅浏览不支持拖拽；
 * 统计聚合逻辑在 domain/activity.ts 的 workspaceDocStats）。
 * R002 规格：内容区最大宽度 960px。
 */

import { useEffect, useMemo, useState } from "react";
import type { DocumentContent, Page } from "../domain/types";
import { formatRelativeTime, workspaceDocStats } from "../domain/activity";
import { buildChildrenByParent } from "../domain/pageTree";
import { useAppServices } from "../state/AppServicesProvider";
import {
  useWorkspaceCommands,
  useWorkspaceData,
} from "../state/WorkspaceSessionContext";
import { useNavigationCommands } from "../state/NavigationContext";
import { useOverlay } from "../state/OverlayContext";
import {
  IconBook,
  IconChevronDown,
  IconChevronRight,
  IconMenu,
  IconStar,
  IconStarFilled,
  PageIcon,
} from "./ui/icons";

/** 知识库首页：头部信息、统计、主操作与完整目录概览（不拖拽）。 */
export function WorkspaceHome() {
  const services = useAppServices();
  const { workspace, pages } = useWorkspaceData();
  const { createPage, toggleWorkspaceFavorite, refreshCurrentWorkspace } =
    useWorkspaceCommands();
  const { openDocument } = useNavigationCommands();
  const { openTreeDrawer } = useOverlay();
  const [contents, setContents] = useState<DocumentContent[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [now] = useState(() => Date.now());
  // 「重新扫描知识库」进行中（R006-C3 FR-26，仅 Desktop 入口渲染）。
  const [rescanning, setRescanning] = useState(false);
  // FR-26/§36.4：仅 Desktop（有 desktopExtras 过渡通道且具备本地目录能力）
  // 提供主动刷新；§34.1 明确不做文件监听，只支持用户主动刷新。
  const canRescan =
    services.desktopExtras !== undefined &&
    services.capabilities.localDirectory;

  // 总字数统计需要正文快照，页面元数据里没有，只能额外取内容行
  useEffect(() => {
    let cancelled = false;
    void services.queries.document.listAllContents().then((list) => {
      if (!cancelled) setContents(list);
    });
    return () => {
      cancelled = true;
    };
  }, [services]);

  const stats = useMemo(
    () => (workspace ? workspaceDocStats(pages, contents, workspace.id) : null),
    [workspace, pages, contents],
  );

  // 邻接表（R003 阶段 7）：pages 变化时一次构建，目录概览不再逐层全数组过滤。
  // 注意：必须在 workspace 早退之前调用，Hook 顺序不能依赖条件分支。
  const childrenByParent = useMemo(() => buildChildrenByParent(pages), [pages]);

  if (!workspace) {
    return <div className="main-empty">请选择或新建一个知识库。</div>;
  }

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderDocRow = (page: Page) => (
    <div key={page.id} className="ws-home__doc">
      <button
        type="button"
        className="ws-home__doc-title"
        onClick={() => void openDocument(page.id)}
      >
        <PageIcon icon={page.icon} kind="document" size={14} />
        {page.title || "无标题"}
      </button>
      <span className="ws-home__doc-time">
        {formatRelativeTime(now, page.updatedAt)}
      </span>
    </div>
  );

  const liveChildren = (parentId: string | null) =>
    (childrenByParent.get(parentId) ?? []).filter(
      (p) => p.deletedAt === null && p.workspaceId === workspace.id,
    );

  const renderNodes = (parentId: string | null, depth: number) => {
    // 概览只展示当前知识库的节点；同级按 position 排序
    const nodes = liveChildren(parentId);
    return nodes.map((page) => {
      if (page.kind === "document") return renderDocRow(page);
      const children = liveChildren(page.id);
      const isCollapsed = collapsed.has(page.id);
      return (
        <section
          key={page.id}
          className="ws-home__group"
          // 分组按层级缩进，分组内的子节点从 depth 0 重新起排
          style={{ marginLeft: depth * 16 }}
          aria-label={page.title || "未命名分组"}
        >
          <button
            type="button"
            className="ws-home__group-header"
            aria-expanded={!isCollapsed}
            onClick={() => toggleCollapse(page.id)}
          >
            <span aria-hidden="true">
              {isCollapsed ? (
                <IconChevronRight size={12} />
              ) : (
                <IconChevronDown size={12} />
              )}
            </span>
            <PageIcon icon={page.icon} kind="group" size={14} />
            {page.title || "未命名分组"}
          </button>
          {!isCollapsed &&
            (children.length > 0 ? (
              renderNodes(page.id, 0)
            ) : (
              <div className="ws-home__group-empty">空分组</div>
            ))}
        </section>
      );
    });
  };

  const topLevel = liveChildren(null);
  const favorite = workspace.favoriteAt !== null;

  // FR-26：扫描缓存失效 + 重新扫描（desktopExtras）→ 刷新页面树/标签镜像。
  const rescanVault = async () => {
    if (!services.desktopExtras || rescanning) return;
    setRescanning(true);
    try {
      await services.desktopExtras.rescanVault(workspace.id);
      await refreshCurrentWorkspace();
    } finally {
      setRescanning(false);
    }
  };

  return (
    <div className="ws-home">
      <div className="ws-home__inner">
        <header className="ws-home__header">
          <button
            type="button"
            className="icon-button tree-toggle"
            aria-label="打开文档树"
            onClick={openTreeDrawer}
          >
            <IconMenu />
          </button>
          <span className="ws-home__icon" aria-hidden="true">
            {workspace.icon ?? <IconBook size={20} />}
          </span>
          <div className="ws-home__heading">
            <h1 className="ws-home__name">{workspace.name}</h1>
            <p className="ws-home__desc">
              {workspace.description ||
                "用分组组织这个知识库的文档；从下方目录或左侧树开始。"}
            </p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={favorite ? "取消收藏知识库" : "收藏知识库"}
            aria-pressed={favorite}
            title={favorite ? "取消收藏" : "收藏"}
            onClick={() => void toggleWorkspaceFavorite(workspace.id)}
          >
            {favorite ? <IconStarFilled /> : <IconStar />}
          </button>
        </header>

        <div className="ws-home__meta">
          <span>{stats?.docCount ?? 0} 篇文档</span>
          <span aria-hidden="true">·</span>
          <span>共 {(stats?.totalChars ?? 0).toLocaleString()} 字</span>
          <span className="ws-home__meta-spacer" />
          {canRescan && (
            <button
              type="button"
              className="button"
              disabled={rescanning}
              onClick={() => void rescanVault()}
            >
              {rescanning ? "正在重新扫描…" : "重新扫描"}
            </button>
          )}
          <button
            type="button"
            className="button button--primary"
            onClick={() => void createPage("document", null)}
          >
            新建文档
          </button>
          <button
            type="button"
            className="button"
            onClick={() => void createPage("group", null)}
          >
            新建分组
          </button>
        </div>

        <section className="ws-home__toc" aria-label="目录概览">
          <h2 className="ws-home__toc-title">目录</h2>
          {topLevel.length === 0 ? (
            <div className="ws-home__empty">
              这个知识库还是空的。点击「新建文档」写下第一篇，或用「新建分组」先规划结构。
            </div>
          ) : (
            renderNodes(null, 0)
          )}
        </section>
      </div>
    </div>
  );
}
