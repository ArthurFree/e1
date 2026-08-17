/**
 * @file 文档冲突与保存状态 hook（R004 阶段 7 §7.2/§7.3，自 MainArea 提取）。
 *
 * 承载保存状态机的组件侧镜像、其他标签页正文落盘事件的三种接收分支，
 * 以及冲突面板的四个处理选项（重新载入 / 另存副本 / 强制覆盖 / 复制内容）。
 * 正文替换本身由 useDocumentSession 拥有，经 onContentReloaded 注入。
 *
 * R007 阶段 3 §3.4「当前文档策略」：Desktop 装配 externalVaultChanges 时，
 * 外部修改/移动——本地干净自动重载 + 轻量提示，本地 dirty 复用冲突面板；
 * 外部删除——dirty 保留内存并允许另存副本，clean 进入「源文件已删除」
 * 错误块。相关状态均按 Document Session 归属，切换文档自然失效。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import type { DocumentContent, Page } from "../../../domain/types";
import { parseDocumentContent } from "../../../domain/validation/documentContent";
import type { DocumentEditorController } from "../../../application/services/DocumentEditorController";
import { useAppServices } from "../../../state/AppServicesProvider";
import { useWorkspaceCommands } from "../../../state/WorkspaceSessionContext";
import { useNavigationCommands } from "../../../state/NavigationContext";
import type { SaveState } from "../../editor/DocumentEditor";

/** DocumentEditor 注册的冲突处理动作；null 表示注销（编辑器已销毁）。 */
type ConflictActions = { forceOverwrite(): void } | null;

/** 外部重载轻量提示的自动消失时长（ms，R007 §3.4）。 */
const EXTERNAL_RELOAD_NOTICE_MS = 5000;

export interface DocumentConflict {
  saveState: SaveState;
  /** 冲突提示条是否可见（乐观锁冲突或其他标签页保存 + 本地未保存修改）。 */
  conflictVisible: boolean;
  /** 外部修改/移动已自动重载的轻量提示（R007 §3.4，仅 Desktop 出现）。 */
  externalReloadNotice: boolean;
  /** 关闭外部重载轻量提示。 */
  dismissExternalReloadNotice(): void;
  /**
   * 当前文档源文件被外部删除的状态（R007 §3.4）：
   * "clean" → 正文区替换为「源文件已删除」错误块；
   * "dirty" → 保留编辑器内存，提示条提供「另存副本」入口。
   */
  externalDeleted: "clean" | "dirty" | null;
  onSaveStateChange(state: SaveState): void;
  onRegisterRetry(retry: () => void): void;
  onRegisterConflictActions(actions: ConflictActions): void;
  /** 重试保存（保存状态指示器与有损保存提示条共用）。 */
  retrySave(): void;
  /** 冲突处理③「强制覆盖」：由 DocumentEditor 注册的动作。 */
  forceOverwrite(): void;
  reloadFromDisk(): Promise<void>;
  saveConflictCopy(): Promise<void>;
  copyConflictContent(): void;
}

export function useDocumentConflict(input: {
  page: Page | null;
  sessionKey: string;
  /** 正文是否已加载（冲突面板只在有正文时出现）。 */
  contentLoaded: boolean;
  editor: Editor | null;
  editorController: DocumentEditorController | null;
  /** 以磁盘最新正文替换当前内容并重建编辑器。 */
  onContentReloaded(next: DocumentContent): void;
}): DocumentConflict {
  const {
    page,
    sessionKey,
    contentLoaded,
    editor,
    editorController,
    onContentReloaded,
  } = input;
  const services = useAppServices();
  const { createDocumentWithContent } = useWorkspaceCommands();
  const { openDocument } = useNavigationCommands();

  const [saveState, setSaveState] = useState<SaveState>({
    status: "saved",
    savedAt: null,
    errorKind: null,
  });
  // 其他标签页保存了当前编辑文档且本地有未保存修改（R004 §7.2）：
  // 提前提示冲突，与乐观锁冲突 UI（errorKind: conflict）汇合为同一面板。
  // 标记按 Document Session 归属，切换文档 / 重试加载即自然失效。
  const [remoteConflictFor, setRemoteConflictFor] = useState<string | null>(
    null,
  );
  // R007 阶段 3 §3.4：外部变更状态（仅 Desktop 装配 externalVaultChanges
  // 时产生）。与 remoteConflictFor 同口径按 Document Session 归属，
  // 切换文档 / 重试加载即自然失效。
  const [externalReloadNoticeFor, setExternalReloadNoticeFor] = useState<
    string | null
  >(null);
  const [externalDeletedFor, setExternalDeletedFor] = useState<{
    sessionKey: string;
    kind: "clean" | "dirty";
  } | null>(null);
  // 供外部变更订阅回调读取最新值（订阅本身保持稳定引用）。
  const externalDeletedForRef = useRef(externalDeletedFor);
  externalDeletedForRef.current = externalDeletedFor;

  const retrySaveRef = useRef<(() => void) | null>(null);
  // 冲突处理动作（R004 阶段 7）：由 DocumentEditor 注册「强制覆盖」。
  const conflictActionsRef = useRef<ConflictActions>(null);
  // 供同步频道订阅回调读取最新值（订阅本身保持稳定引用）。
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;
  const pageRef = useRef(page);
  pageRef.current = page;
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;
  // 外部重载轻量提示的自动消失计时器（约 5 秒，R007 §3.4）。
  const reloadNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  /** 显示外部重载轻量提示并重置自动消失计时。 */
  const showExternalReloadNotice = useCallback((key: string) => {
    setExternalReloadNoticeFor(key);
    if (reloadNoticeTimerRef.current !== null) {
      clearTimeout(reloadNoticeTimerRef.current);
    }
    reloadNoticeTimerRef.current = setTimeout(() => {
      reloadNoticeTimerRef.current = null;
      setExternalReloadNoticeFor(null);
    }, EXTERNAL_RELOAD_NOTICE_MS);
  }, []);

  const dismissExternalReloadNotice = useCallback(() => {
    if (reloadNoticeTimerRef.current !== null) {
      clearTimeout(reloadNoticeTimerRef.current);
      reloadNoticeTimerRef.current = null;
    }
    setExternalReloadNoticeFor(null);
  }, []);

  // 卸载时清理提示计时器。
  useEffect(
    () => () => {
      if (reloadNoticeTimerRef.current !== null) {
        clearTimeout(reloadNoticeTimerRef.current);
      }
    },
    [],
  );

  const onSaveStateChange = useCallback((state: SaveState) => {
    setSaveState(state);
  }, []);

  const onRegisterRetry = useCallback((retry: () => void) => {
    retrySaveRef.current = retry;
  }, []);

  const onRegisterConflictActions = useCallback((actions: ConflictActions) => {
    conflictActionsRef.current = actions;
  }, []);

  // 两个动作只是转发编辑器注册的最新回调，与原先的内联箭头等价，不做记忆化。
  const retrySave = () => retrySaveRef.current?.();
  const forceOverwrite = () => conflictActionsRef.current?.forceOverwrite();

  /**
   * 冲突处理①「重新载入磁盘版本」（R004 阶段 7）：丢弃本地未保存修改，
   * 以磁盘最新正文重建编辑器（代次 +1 → 协调器随之重建，乐观锁起点更新
   * 为最新 version）；同时清理恢复缓冲，避免旧内容再次提示。
   * 其他标签页保存当前文档且本地干净时，也经本函数自动重载（§7.2）。
   */
  const reloadFromDisk = useCallback(async () => {
    const current = pageRef.current;
    if (!current) return;
    const latest = await services.queries.document.getContent(current.id);
    if (!latest || pageRef.current?.id !== current.id) return;
    const parsed = parseDocumentContent(latest.contentJson);
    if (!parsed.ok) return;
    void services.recoveryStore.discard(current.id);
    services.queries.search.syncText(
      current.id,
      latest.textSnapshot,
      latest.updatedAt,
    );
    setRemoteConflictFor(null);
    onContentReloaded({ ...latest, contentJson: parsed.value });
  }, [services, onContentReloaded]);

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
          setRemoteConflictFor(sessionKeyRef.current);
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

  // 外部 Vault 变更（R007 阶段 3 §3.4，仅 Desktop 装配该服务；Web 行为
  // 不变）：只处理当前编辑文档的变更——
  // modified/moved：本地干净自动重载 + 轻量提示，dirty 复用冲突面板；
  // deleted：dirty 保留编辑器内存（另存副本入口），clean 进入错误块；
  // created：仅当当前文档处于「外部删除」状态（同 stable id 被外部重建）
  // 时按外部修改处理，其余忽略。
  useEffect(() => {
    const external = services.externalVaultChanges;
    if (!external) return;
    return external.subscribe((changes) => {
      const current = pageRef.current;
      if (!current || current.kind !== "document") return;
      for (const change of changes) {
        if (change.pageId !== current.id) continue;
        if (change.type === "modified" || change.type === "moved") {
          setExternalDeletedFor(null);
          if (saveStateRef.current.status === "saved") {
            showExternalReloadNotice(sessionKeyRef.current);
            void reloadFromDisk();
          } else {
            setRemoteConflictFor(sessionKeyRef.current);
          }
        } else if (change.type === "deleted") {
          dismissExternalReloadNotice();
          setExternalDeletedFor({
            sessionKey: sessionKeyRef.current,
            kind: saveStateRef.current.status === "saved" ? "clean" : "dirty",
          });
        } else if (change.type === "created") {
          // 被外部删除的当前文档又被外部重建（同 stable id 回到树中）：
          // 视为一次外部修改——清除删除状态，clean 自动重载 / dirty 进冲突；
          // 与当前文档无关的 created 忽略。
          if (
            externalDeletedForRef.current?.sessionKey !== sessionKeyRef.current
          ) {
            continue;
          }
          setExternalDeletedFor(null);
          if (saveStateRef.current.status === "saved") {
            showExternalReloadNotice(sessionKeyRef.current);
            void reloadFromDisk();
          } else {
            setRemoteConflictFor(sessionKeyRef.current);
          }
        }
      }
    });
  }, [
    services,
    reloadFromDisk,
    showExternalReloadNotice,
    dismissExternalReloadNotice,
  ]);

  // 乐观锁冲突（本地保存撞版本）或其他标签页保存了当前文档且本地 dirty：
  // 两种来源汇合为同一冲突面板（R004 阶段 7）。
  const conflictVisible =
    page?.kind === "document" &&
    contentLoaded &&
    (remoteConflictFor === sessionKey ||
      (saveState.status === "error" && saveState.errorKind === "conflict"));

  // 外部变更状态按 sessionKey 归属换算为当前会话的展示值。
  const externalReloadNotice =
    externalReloadNoticeFor !== null && externalReloadNoticeFor === sessionKey;
  const externalDeleted =
    externalDeletedFor?.sessionKey === sessionKey
      ? externalDeletedFor.kind
      : null;

  return {
    saveState,
    conflictVisible,
    externalReloadNotice,
    dismissExternalReloadNotice,
    externalDeleted,
    onSaveStateChange,
    onRegisterRetry,
    onRegisterConflictActions,
    retrySave,
    forceOverwrite,
    reloadFromDisk,
    saveConflictCopy,
    copyConflictContent,
  };
}
