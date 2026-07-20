import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import {
  clearBlockFormatting,
  convertBlock,
  deleteBlock,
  duplicateBlock,
  getTopLevelBlock,
  moveBlock,
  type ConvertTarget,
} from "../../editor/blockActions";

const CONVERT_OPTIONS: { target: ConvertTarget; label: string }[] = [
  { target: "paragraph", label: "正文" },
  { target: "heading1", label: "标题 1" },
  { target: "heading2", label: "标题 2" },
  { target: "heading3", label: "标题 3" },
  { target: "blockquote", label: "引用" },
  { target: "codeBlock", label: "代码块" },
  { target: "bulletList", label: "项目列表" },
  { target: "orderedList", label: "编号列表" },
  { target: "taskList", label: "待办列表" },
];

interface BlockHandleProps {
  editor: Editor;
}

interface HandleState {
  top: number;
  blockPos: number;
}

/**
 * 块把手（DragHandle 的开源等价实现）：
 * 悬停块时出现在左侧，可拖动块上下移动，菜单提供复制/删除/转换/清除格式。
 */
export function BlockHandle({ editor }: BlockHandleProps) {
  const [handle, setHandle] = useState<HandleState | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragPosRef = useRef<number | null>(null);
  const menuOpenRef = useRef(false);
  menuOpenRef.current = menuOpen;

  const locateBlock = useCallback(
    (clientX: number, clientY: number): HandleState | null => {
      const coords = editor.view.posAtCoords({ left: clientX, top: clientY });
      if (!coords) return null;
      const block = getTopLevelBlock(editor, coords.pos);
      if (!block) return null;
      const dom = editor.view.nodeDOM(block.pos);
      if (!(dom instanceof HTMLElement)) return null;
      const containerRect = rootRef.current?.parentElement?.getBoundingClientRect();
      if (!containerRect) return null;
      const rect = dom.getBoundingClientRect();
      return { top: rect.top - containerRect.top, blockPos: block.pos };
    },
    [editor],
  );

  useEffect(() => {
    const dom = editor.view.dom;

    const onMouseMove = (event: MouseEvent) => {
      if (menuOpenRef.current || dragPosRef.current !== null) return;
      setHandle(locateBlock(event.clientX, event.clientY));
    };
    const onMouseLeave = () => {
      if (!menuOpenRef.current && dragPosRef.current === null) setHandle(null);
    };
    const onDragOver = (event: DragEvent) => {
      if (dragPosRef.current !== null) event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      const from = dragPosRef.current;
      dragPosRef.current = null;
      if (from === null) return;
      event.preventDefault();
      const coords = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
      if (!coords) return;
      const block = getTopLevelBlock(editor, coords.pos);
      if (!block) return;
      const domBlock = editor.view.nodeDOM(block.pos);
      let insertPos = block.end;
      if (domBlock instanceof HTMLElement) {
        const rect = domBlock.getBoundingClientRect();
        insertPos =
          event.clientY < rect.top + rect.height / 2 ? block.pos : block.end;
      }
      moveBlock(editor, from, insertPos);
      setHandle(null);
    };

    dom.addEventListener("mousemove", onMouseMove);
    dom.addEventListener("mouseleave", onMouseLeave);
    dom.addEventListener("dragover", onDragOver);
    dom.addEventListener("drop", onDrop);
    return () => {
      dom.removeEventListener("mousemove", onMouseMove);
      dom.removeEventListener("mouseleave", onMouseLeave);
      dom.removeEventListener("dragover", onDragOver);
      dom.removeEventListener("drop", onDrop);
    };
  }, [editor, locateBlock]);

  // 菜单打开时点击外部或 Escape 关闭。
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  if (!handle) {
    return <div ref={rootRef} className="block-handle" style={{ display: "none" }} />;
  }

  const runAction = (action: () => void) => {
    action();
    setMenuOpen(false);
    setHandle(null);
  };

  return (
    <div ref={rootRef} className="block-handle" style={{ top: handle.top }}>
      <button
        type="button"
        className="block-handle__button"
        aria-label="拖动块"
        title="拖动以移动块"
        draggable
        onDragStart={(event) => {
          dragPosRef.current = handle.blockPos;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", "");
        }}
        onDragEnd={() => {
          dragPosRef.current = null;
        }}
      >
        ⠿
      </button>
      <button
        type="button"
        className="block-handle__button"
        aria-label="块菜单"
        aria-expanded={menuOpen}
        title="块操作"
        onClick={() => setMenuOpen((v) => !v)}
      >
        ＋
      </button>

      {menuOpen && (
        <div className="block-menu" role="menu" aria-label="块操作菜单">
          <button
            type="button"
            role="menuitem"
            className="block-menu__item"
            onClick={() => runAction(() => duplicateBlock(editor, handle.blockPos))}
          >
            复制
          </button>
          <button
            type="button"
            role="menuitem"
            className="block-menu__item"
            onClick={() => runAction(() => deleteBlock(editor, handle.blockPos))}
          >
            删除
          </button>
          <button
            type="button"
            role="menuitem"
            className="block-menu__item"
            onClick={() => runAction(() => clearBlockFormatting(editor, handle.blockPos))}
          >
            清除格式
          </button>
          <div className="block-menu__divider" role="separator" />
          <div className="block-menu__group">转换为</div>
          {CONVERT_OPTIONS.map((option) => (
            <button
              key={option.target}
              type="button"
              role="menuitem"
              className="block-menu__item"
              onClick={() =>
                runAction(() => convertBlock(editor, handle.blockPos, option.target))
              }
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
