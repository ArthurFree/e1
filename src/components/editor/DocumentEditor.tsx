import { useEffect, useMemo, useRef } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { contentRepository } from "../../infrastructure/repositories";
import { useApp } from "../../state/AppState";
import { useDebouncedCallback } from "../../hooks/useDebouncedCallback";
import { buildEditorExtensions } from "../../editor/extensions";
import { BubbleToolbar } from "./BubbleToolbar";
import { BlockHandle } from "./BlockHandle";
import { TableToolbar } from "./TableToolbar";
import { AIAssistantPanel } from "./AIAssistantPanel";

interface DocumentEditorProps {
  pageId: string;
  initialContent: unknown;
  onEditorReady(editor: Editor | null): void;
}

/**
 * 编辑器宿主 + 保存适配器：
 * 变更经 800ms 防抖写入 IndexedDB；切换文档或卸载时强制落盘。
 */
export function DocumentEditor({
  pageId,
  initialContent,
  onEditorReady,
}: DocumentEditorProps) {
  const { pages } = useApp();
  const editorRef = useRef<Editor | null>(null);

  const { debounced, flush } = useDebouncedCallback(
    (json: unknown, text: string) => {
      void contentRepository.save(pageId, json, text);
    },
    800,
  );

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
        debounced(e.getJSON(), e.getText());
      },
    },
    [pageId],
  );

  useEffect(() => {
    editorRef.current = editor;
    onEditorReady(editor);
    return () => {
      onEditorReady(null);
    };
  }, [editor, onEditorReady]);

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
