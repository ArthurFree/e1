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
  status: "saved" | "dirty" | "saving" | "error";
  /** 最近一次保存成功时间。 */
  savedAt: number | null;
}

interface DocumentEditorProps {
  pageId: string;
  initialContent: unknown;
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
      content: initialContent as never,
      autofocus: "end",
      onUpdate: ({ editor: e }) => {
        setSaveState((s) => ({ ...s, status: "dirty" }));
        debounced(e.getJSON(), e.getText());
      },
    },
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
