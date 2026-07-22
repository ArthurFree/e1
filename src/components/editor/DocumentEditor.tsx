/**
 * 文档编辑器宿主组件（编辑器装配层）。
 *
 * 职责：创建 Tiptap 编辑器实例、装配浮动 UI（选区工具栏、表格操作条、
 * 块把手、AI 面板），并把编辑器变更接入持久化——800ms 防抖保存到
 * IndexedDB、切换文档或卸载时强制落盘、保存成功后按间隔生成自动版本。
 *
 * 架构位置：UI 只依赖仓储接口（infrastructure/repositories）与领域策略
 * （domain/revisions），文档 JSON 是唯一编辑真相（AGENTS.md 架构约束）。
 * 保存状态机见 R001 §8.1，状态展示由顶栏的 SaveStateIndicator 承担。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import {
  attachmentRepository,
  contentRepository,
  revisionRepository,
} from "../../infrastructure/repositories";
import { useApp } from "../../state/AppState";
import { useDebouncedCallback } from "../../hooks/useDebouncedCallback";
import { collectAttachmentIds } from "../../editor/attachment";
import { buildEditorExtensions } from "../../editor/extensions";
import {
  INTERVAL_REVISION_KEEP,
  shouldCreateIntervalRevision,
} from "../../domain/revisions";
import { BubbleToolbar } from "./BubbleToolbar";
import { BlockHandle } from "./BlockHandle";
import { TableToolbar } from "./TableToolbar";
import { AIAssistantPanel } from "./AIAssistantPanel";

/** 保存状态机（R001 §8.1）：saved → dirty → saving → saved / error。 */
export interface SaveState {
  /** saved 已落盘；dirty 有未保存变更；saving 写入中；error 写入失败（保留内容，可重试）。 */
  status: "saved" | "dirty" | "saving" | "error";
  /** 最近一次保存成功时间。 */
  savedAt: number | null;
}

/** DocumentEditor 入参。 */
interface DocumentEditorProps {
  /** 当前文档页面 ID；变化时编辑器实例重建，保证切换文档后状态干净。 */
  pageId: string;
  /** 文档内容 JSON（Tiptap doc），来自仓储；为兼容历史数据保持 unknown。 */
  initialContent: unknown;
  /** 编辑器实例就绪/销毁回调（null 表示已销毁），供父级持有并转发命令。 */
  onEditorReady(editor: Editor | null): void;
  /** 保存状态变化通知（顶栏展示）。 */
  onSaveStateChange?(state: SaveState): void;
  /** 注册「保存失败-重试」动作，供顶栏按钮触发。 */
  onRegisterRetry?(retry: () => void): void;
}

/**
 * 编辑器宿主 + 保存适配器：
 * 变更经 800ms 防抖写入 IndexedDB；切换文档或卸载时强制落盘。
 * 保存成功后按 5 分钟间隔生成 interval 版本（去重、自动版本上限 100）。
 */
export function DocumentEditor({
  pageId,
  initialContent,
  onEditorReady,
  onSaveStateChange,
  onRegisterRetry,
}: DocumentEditorProps) {
  const { pages } = useApp();
  const editorRef = useRef<Editor | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ status: "saved", savedAt: null });
  // 上一个自动版本时间；挂载时从仓储读取，避免重启后立刻产生重复版本。
  const lastIntervalAtRef = useRef<number | null>(null);

  useEffect(() => {
    lastIntervalAtRef.current = null;
    void revisionRepository.listByPage(pageId).then((list) => {
      lastIntervalAtRef.current =
        list.find((r) => r.reason === "interval")?.createdAt ?? null;
    });
  }, [pageId]);

  useEffect(() => {
    onSaveStateChange?.(saveState);
  }, [saveState, onSaveStateChange]);

  const doSave = useCallback(
    async (json: unknown, text: string) => {
      setSaveState((s) => ({ ...s, status: "saving" }));
      try {
        await contentRepository.save(pageId, json, text);
        // 保存完成后清理不再被引用的孤儿附件。
        await attachmentRepository.removeOrphans(pageId, collectAttachmentIds(json));
        // 间隔自动版本：内容变化且距上一个自动版本 ≥ 5 分钟。
        const now = Date.now();
        if (shouldCreateIntervalRevision(lastIntervalAtRef.current, now)) {
          const created = await revisionRepository.add(pageId, json, text, "interval");
          if (created) {
            lastIntervalAtRef.current = now;
            await revisionRepository.pruneInterval(pageId, INTERVAL_REVISION_KEEP);
          }
        }
        setSaveState({ status: "saved", savedAt: now });
      } catch {
        // 不伪造成功：失败保留编辑器内容，顶栏提供重试。
        setSaveState((s) => ({ ...s, status: "error" }));
      }
    },
    [pageId],
  );

  const { debounced, flush } = useDebouncedCallback(
    (json: unknown, text: string) => {
      void doSave(json, text);
    },
    800,
  );

  // 保存失败重试：以当前编辑器内容立即保存。
  useEffect(() => {
    onRegisterRetry?.(() => {
      const e = editorRef.current;
      if (e && !e.isDestroyed) void doSave(e.getJSON(), e.getText());
    });
  }, [doSave, onRegisterRetry]);

  // 切换文档前保存上一篇的挂起编辑。
  const pageIdRef = useRef(pageId);
  useEffect(() => {
    if (pageIdRef.current !== pageId) {
      flush();
      pageIdRef.current = pageId;
    }
  }, [pageId, flush]);

  // @ 提及候选只含文档页：知识库节点不可被提及链接。
  const mentionPages = useMemo(
    () => pages.filter((p) => p.kind === "document"),
    [pages],
  );

  const editor = useEditor(
    {
      extensions: buildEditorExtensions({
        mentionPages,
        getEditor: () => editorRef.current as Editor,
      }),
      // Tiptap content 类型不含 unknown；历史数据均为合法 doc JSON，仅断言不校验。
      content: initialContent as never,
      autofocus: "end",
      onUpdate: ({ editor: e }) => {
        setSaveState((s) => ({ ...s, status: "dirty" }));
        debounced(e.getJSON(), e.getText());
      },
    },
    // pageId 变化时重建编辑器实例，切换文档后内容与扩展状态从头装配。
    [pageId],
  );

  useEffect(() => {
    editorRef.current = editor;
    // 供附件类命令读取当前文档 ID（附件记录归属页面）。
    if (editor) {
      (editor.storage as unknown as Record<string, unknown>).attachmentPageId = pageId;
    }
    onEditorReady(editor);
    return () => {
      onEditorReady(null);
    };
  }, [editor, pageId, onEditorReady]);

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
