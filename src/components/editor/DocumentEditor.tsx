/**
 * 文档编辑器宿主组件（编辑器装配层）。
 *
 * 职责：创建 Tiptap 编辑器实例、装配浮动 UI（选区工具栏、表格操作条、
 * 块把手、AI 面板），并把编辑器变更交给 DocumentSaveCoordinator（R003
 * 阶段 1）：同一文档保存串行执行、代次（generation）管理、附件清理与
 * 间隔自动版本只跟随最新快照、localStorage 恢复缓冲兜底。
 *
 * 架构位置：持久化流程在 application 层的协调器中，组件只负责监听
 * Tiptap 更新、生成快照、提交快照与展示保存状态；仓储经服务容器
 * （useAppServices）注入，组件不直接 import infrastructure（R003 阶段 5）。
 * 保存状态机见 R001 §8.1，状态展示由顶栏的 SaveStateIndicator 承担。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import type { Page } from "../../domain/types";
import { useAppServices } from "../../state/AppServicesProvider";
import { useWorkspaceSession } from "../../state/WorkspaceSessionContext";
import { useDebouncedCallback } from "../../hooks/useDebouncedCallback";
import { buildEditorExtensions } from "../../editor/extensions";
import type {
  DocumentSaveCoordinator,
  SaveCoordinatorState,
} from "../../application/services/SaveCoordinator";
import type { DocumentEditorController } from "../../application/services/DocumentEditorController";
import { BubbleToolbar } from "./BubbleToolbar";
import { BlockHandle } from "./BlockHandle";
import { TableToolbar } from "./TableToolbar";
import { AIAssistantPanel } from "./AIAssistantPanel";

/** 保存状态机（R001 §8.1）：saved → dirty → saving → saved / error。 */
export type SaveState = SaveCoordinatorState;

/** DocumentEditor 入参。 */
interface DocumentEditorProps {
  /** 当前文档页面 ID；变化时编辑器实例重建，保证切换文档后状态干净。 */
  pageId: string;
  /** 文档内容 JSON（Tiptap doc），来自仓储；为兼容历史数据保持 unknown。 */
  initialContent: unknown;
  /** 加载正文的磁盘版本号（R004 阶段 7 乐观锁起点）；新文档无记录时为 0。 */
  initialVersion: number;
  /** 编辑器实例就绪/销毁回调（null 表示已销毁），供父级持有并转发命令。 */
  onEditorReady(editor: Editor | null): void;
  /** 保存状态变化通知（顶栏展示）。 */
  onSaveStateChange?(state: SaveState): void;
  /** 注册「保存失败-重试」动作，供顶栏按钮触发。 */
  onRegisterRetry?(retry: () => void): void;
  /**
   * 注册冲突处理动作（R004 阶段 7）：乐观锁冲突时「强制覆盖」需经
   * 协调器以磁盘最新版本重试当前快照；组件卸载时以 null 注销。
   */
  onRegisterConflictActions?(actions: { forceOverwrite(): void } | null): void;
  /**
   * 恢复缓冲应用后的保存请求 ID：变化时对当前内容立即执行一次保存，
   * 避免恢复的内容再次只停留在内存（R003 §1.4）。
   */
  restoreRequestId?: number;
  /**
   * 编辑器控制器就绪回调（R004 阶段 3）：版本恢复等外部写入经控制器
   * 与保存协调器串行化，null 表示编辑器已销毁。
   */
  onControllerReady?(controller: DocumentEditorController | null): void;
}

/**
 * 编辑器宿主：变更经 800ms 防抖提交给保存协调器；切换文档或卸载时
 * 强制落盘（排空旧协调器队列后销毁）。
 */
export function DocumentEditor({
  pageId,
  initialContent,
  initialVersion,
  onEditorReady,
  onSaveStateChange,
  onRegisterRetry,
  onRegisterConflictActions,
  restoreRequestId,
  onControllerReady,
}: DocumentEditorProps) {
  const { pages } = useWorkspaceSession();
  const services = useAppServices();
  const editorRef = useRef<Editor | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({
    status: "saved",
    savedAt: null,
    errorKind: null,
  });
  // 每个文档一个保存协调器；pageIdRef 先于渲染更新，供回调判断「当前文档」。
  const coordinatorsRef = useRef(new Map<string, DocumentSaveCoordinator>());
  const pageIdRef = useRef(pageId);
  // 版本恢复的 setContent 抑制（R004 阶段 3）：恢复替换编辑器内容时
  // 不触发防抖保存，恢复只经协调器串行提交一次（INV-06）。
  const restoreSuppressRef = useRef(false);

  const getCoordinator = useCallback(
    (pid: string) => {
      let coordinator = coordinatorsRef.current.get(pid);
      if (!coordinator) {
        // 乐观锁起点为编辑器加载时的磁盘版本（R004 阶段 7）。
        coordinator = services.createSaveCoordinator(
          pid,
          (state) => {
            // 只有当前文档的协调器驱动 UI；旧协调器排空期间的状态不外发。
            if (pid === pageIdRef.current) setSaveState(state);
          },
          { initialVersion },
        );
        coordinatorsRef.current.set(pid, coordinator);
      }
      return coordinator;
    },
    [services, initialVersion],
  );

  useEffect(() => {
    onSaveStateChange?.(saveState);
  }, [saveState, onSaveStateChange]);

  // 防抖保存：快照自带编辑发生时的 pageId，即使 flush 发生在切换文档后，
  // 也会路由到旧文档的协调器，绝不写入新文档。
  const { debounced, flush } = useDebouncedCallback(
    (pid: string, json: unknown, text: string) => {
      void getCoordinator(pid)
        .enqueue({ contentJson: json, textSnapshot: text })
        .catch(() => {
          // 保存失败已由协调器经 onStateChange 发布为 error，顶栏提供重试。
        });
    },
    800,
  );

  // 保存失败重试：重试当前文档协调器中的最新快照。
  useEffect(() => {
    onRegisterRetry?.(() => {
      const coordinator = coordinatorsRef.current.get(pageIdRef.current);
      if (coordinator) {
        void coordinator.retryLatest().catch(() => {
          // 重试失败同样经 onStateChange 发布为 error。
        });
      }
    });
  }, [onRegisterRetry]);

  // 冲突处理动作（R004 阶段 7）：「强制覆盖」读取磁盘最新版本后以之为
  // expectedVersion 重试当前快照；成功与否都经 onStateChange 发布。
  useEffect(() => {
    onRegisterConflictActions?.({
      forceOverwrite: () => {
        const pid = pageIdRef.current;
        const coordinator = coordinatorsRef.current.get(pid);
        if (!coordinator) return;
        void services.content
          .get(pid)
          .then((latest) => {
            coordinator.setLoadedVersion(latest?.version ?? 0);
            return coordinator.retryLatest();
          })
          .catch(() => {
            // 重试失败经 onStateChange 发布为 error。
          });
      },
    });
    return () => onRegisterConflictActions?.(null);
  }, [onRegisterConflictActions, services]);

  // 切换文档：先把挂起的防抖保存提交给旧文档协调器，再排空并销毁它。
  useEffect(() => {
    if (pageIdRef.current !== pageId) {
      const prev = pageIdRef.current;
      pageIdRef.current = pageId;
      flush();
      const old = coordinatorsRef.current.get(prev);
      if (old) {
        coordinatorsRef.current.delete(prev);
        void old.dispose();
      }
      // 新文档从干净的保存状态开始。
      setSaveState({ status: "saved", savedAt: null, errorKind: null });
    }
  }, [pageId, flush]);

  // @ 提及候选只含文档页：知识库节点不可被提及链接。
  // 经 ref 供扩展动态读取（R003 阶段 6）：编辑器实例不随 pages 重建，
  // 但新建/重命名页面后候选立即更新。
  const mentionPagesRef = useRef<Page[]>([]);
  useEffect(() => {
    mentionPagesRef.current = pages.filter((p) => p.kind === "document");
  }, [pages]);

  const editor = useEditor(
    {
      extensions: buildEditorExtensions({
        getMentionPages: () => mentionPagesRef.current,
        getEditor: () => editorRef.current as Editor,
      }),
      // Tiptap content 类型不含 unknown；历史数据均为合法 doc JSON，仅断言不校验。
      content: initialContent as never,
      autofocus: "end",
      onUpdate: ({ editor: e }) => {
        const coordinator = getCoordinator(pageId);
        // 版本恢复的 setContent：跳过防抖保存（恢复经协调器单独提交）。
        if (restoreSuppressRef.current) {
          restoreSuppressRef.current = false;
          return;
        }
        // 每次编辑代次 +1：旧代次保存此后完成不得再把 UI 标记为已保存。
        coordinator.noteEdit();
        debounced(pageId, e.getJSON(), e.getText());
      },
    },
    // pageId 变化时重建编辑器实例，切换文档后内容与扩展状态从头装配。
    [pageId],
  );

  useEffect(() => {
    editorRef.current = editor;
    if (editor) {
      const storage = editor.storage as unknown as Record<string, unknown>;
      // 供附件类命令读取当前文档 ID（附件记录归属页面）与附件仓储
      // （R003 阶段 5：扩展经 storage 通道取仓储，不 import infrastructure）。
      storage.attachmentPageId = pageId;
      storage.attachmentRepository = services.attachment;
    }
    onEditorReady(editor);
    return () => {
      onEditorReady(null);
    };
  }, [editor, pageId, onEditorReady, services]);

  // 编辑器控制器（R004 阶段 3）：版本恢复与保存协调器串行化——
  // flush 防抖与队列 → before-restore 版本 → 经协调器提交目标版本 →
  // setContent 更新编辑器（抑制其防抖保存，不产生第二次写入）。
  useEffect(() => {
    if (!onControllerReady) return;
    if (!editor || editor.isDestroyed) {
      onControllerReady(null);
      return;
    }
    const controller: DocumentEditorController = {
      getSnapshot: () => ({
        contentJson: editor.getJSON(),
        textSnapshot: editor.getText(),
      }),
      flush: async () => {
        flush();
        await getCoordinator(pageId).flush();
      },
      restore: async (target) => {
        flush();
        const coordinator = getCoordinator(pageId);
        await coordinator.flush();
        const current = {
          contentJson: editor.getJSON(),
          textSnapshot: editor.getText(),
        };
        await services.documentCommit.restoreRevision({
          pageId,
          current,
          target,
          commit: (contentJson, textSnapshot) => {
            restoreSuppressRef.current = true;
            editor.commands.setContent(contentJson as never);
            coordinator.noteEdit();
            return coordinator.enqueue({ contentJson, textSnapshot });
          },
        });
      },
    };
    onControllerReady(controller);
    return () => onControllerReady(null);
  }, [editor, pageId, flush, getCoordinator, onControllerReady, services]);

  // 恢复缓冲应用后：对恢复内容立即执行一次保存（每个编辑器实例最多一次）。
  const restoreHandledRef = useRef(0);
  useEffect(() => {
    if (
      restoreRequestId &&
      restoreRequestId !== restoreHandledRef.current &&
      editor &&
      !editor.isDestroyed
    ) {
      restoreHandledRef.current = restoreRequestId;
      const coordinator = getCoordinator(pageId);
      coordinator.noteEdit();
      void coordinator
        .enqueue({
          contentJson: editor.getJSON(),
          textSnapshot: editor.getText(),
        })
        .catch(() => {
          // 保存失败经 onStateChange 发布为 error，顶栏提供重试。
        });
    }
  }, [restoreRequestId, editor, pageId, getCoordinator]);

  // 卸载：提交挂起防抖并销毁全部协调器（dispose 会先排空各自队列）。
  useEffect(() => {
    return () => {
      flush();
      const all = [...coordinatorsRef.current.values()];
      coordinatorsRef.current.clear();
      for (const coordinator of all) void coordinator.dispose();
    };
  }, [flush]);

  if (!editor) return null;

  return (
    <div className="editor">
      <BubbleToolbar editor={editor} />
      <TableToolbar editor={editor} />
      <BlockHandle editor={editor} />
      <AIAssistantPanel editor={editor} />
      <EditorContent editor={editor} className="editor__content" />
    </div>
  );
}
