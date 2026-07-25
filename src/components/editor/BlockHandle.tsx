/**
 * 块把手（Tiptap Pro DragHandle 的开源等价实现，AGENTS.md：不引入 Pro 能力）。
 *
 * 鼠标悬停块时在左侧浮出「拖动 + 菜单」把手：拖动把手经 HTML5 DnD
 * 移动块，菜单提供复制/删除/清除格式/块类型转换。
 * 定位基于 editor.view.posAtCoords 坐标反查；块级操作均委托给
 * editor/blockActions 的纯函数实现。
 *
 * 悬停注意：把手在正文左侧外侧。监听挂在 .editor（含把手与 ProseMirror）上，
 * 指针在把手上时保持当前块；离开时用短延迟，避免穿过空隙时把手闪没。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { Editor } from "@tiptap/core";
import {
  clearBlockFormatting,
  convertBlock,
  deleteBlock,
  duplicateBlock,
  getTopLevelBlock,
  moveBlock,
  resolveBlockDropTarget,
  type ConvertTarget,
} from "../../editor/blockActions";
import { IconGrip, IconPlus } from "../ui/icons";

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

/** BlockHandle 入参。 */
interface BlockHandleProps {
  editor: Editor;
}

/** 当前悬停块的把手定位信息。 */
interface HandleState {
  /** 把手相对编辑器容器的垂直偏移（px）。 */
  top: number;
  /** 目标顶层块在文档中的起始位置，供块操作与拖拽定位。 */
  blockPos: number;
}

/**
 * 块把手（DragHandle 的开源等价实现）：
 * 悬停块时出现在左侧，可拖动块上下移动，菜单提供复制/删除/转换/清除格式。
 */
/** 指针离开正文移向左侧把手时的短暂宽限，避免穿过空隙时把手被立刻卸掉。 */
const HIDE_DELAY_MS = 200;

export function BlockHandle({ editor }: BlockHandleProps) {
  const [handle, setHandle] = useState<HandleState | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // 视口下部空间不足时向上展开菜单（默认向下）。
  const [menuUp, setMenuUp] = useState(false);
  // 拖放指示线相对 .editor 容器的 top（px）；非拖放时为 null。
  const [dropLineTop, setDropLineTop] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  // 拖拽中的源块位置；非 null 时暂停悬停定位，避免把手跟随鼠标跳动。
  const dragPosRef = useRef<number | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 事件监听挂在 DOM 上（非 React 渲染），经 ref 读取最新菜单状态。
  const menuOpenRef = useRef(false);
  useEffect(() => {
    menuOpenRef.current = menuOpen;
  }, [menuOpen]);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const scheduleHide = useCallback(() => {
    clearHideTimer();
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      if (!menuOpenRef.current && dragPosRef.current === null) setHandle(null);
    }, HIDE_DELAY_MS);
  }, [clearHideTimer]);

  const locateBlock = useCallback(
    // 由鼠标坐标反查所在顶层块；坐标落空、块无 DOM 或容器不可用时返回 null（把手隐藏）。
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
    const viewDom = editor.view.dom;
    // 生产环境把手与 ProseMirror 同挂在 .editor 下；测试里 view.dom 可能是独立节点。
    const parent = rootRef.current?.parentElement;
    const hoverRoot =
      parent && parent.contains(viewDom) ? parent : viewDom;

    const onMouseMove = (event: MouseEvent) => {
      if (menuOpenRef.current || dragPosRef.current !== null) return;
      clearHideTimer();
      // 指针已在把手上：保持当前块，避免移向按钮时被重新定位清空。
      if (rootRef.current?.contains(event.target as Node)) return;
      const contentRect = viewDom.getBoundingClientRect();
      // 左侧装把手的留白：把 x 映射到正文左缘，仍能命中同行块。
      const x =
        event.clientX < contentRect.left ? contentRect.left + 1 : event.clientX;
      setHandle(locateBlock(x, event.clientY));
    };
    const onMouseLeave = (event: MouseEvent) => {
      if (menuOpenRef.current || dragPosRef.current !== null) return;
      const related = event.relatedTarget as Node | null;
      // 进入把手或其子节点时不隐藏（relatedTarget 可能是按钮）。
      if (related && rootRef.current?.contains(related)) return;
      // 仍在 hoverRoot 内（如从正文移到同容器的其他子节点）由 mousemove 接管。
      if (related && hoverRoot.contains(related)) return;
      scheduleHide();
    };
    const onDragOver = (event: DragEvent) => {
      if (dragPosRef.current === null) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      const target = resolveBlockDropTarget(editor, event.clientX, event.clientY);
      const containerRect = hoverRoot.getBoundingClientRect();
      if (!target) {
        setDropLineTop(null);
        return;
      }
      setDropLineTop(target.lineClientY - containerRect.top);
    };
    const onDrop = (event: DragEvent) => {
      const from = dragPosRef.current;
      dragPosRef.current = null;
      setDropLineTop(null);
      // 拖放结束必须关掉菜单：否则 setHandle(null) 后 menuOpen 仍为 true，
      // 下次悬停任意块时会未点「+」就自动弹出菜单。
      setMenuOpen(false);
      if (from === null) return;
      event.preventDefault();
      const target = resolveBlockDropTarget(editor, event.clientX, event.clientY);
      if (!target) return;
      moveBlock(editor, from, target.insertPos);
      setHandle(null);
    };
    const onDragEnd = () => {
      dragPosRef.current = null;
      setDropLineTop(null);
      setMenuOpen(false);
    };

    hoverRoot.addEventListener("mousemove", onMouseMove);
    hoverRoot.addEventListener("mouseleave", onMouseLeave);
    // 拖放挂在整块 .editor（含左侧把手列），而不仅是 ProseMirror 正文。
    hoverRoot.addEventListener("dragover", onDragOver);
    hoverRoot.addEventListener("drop", onDrop);
    hoverRoot.addEventListener("dragend", onDragEnd);
    return () => {
      clearHideTimer();
      hoverRoot.removeEventListener("mousemove", onMouseMove);
      hoverRoot.removeEventListener("mouseleave", onMouseLeave);
      hoverRoot.removeEventListener("dragover", onDragOver);
      hoverRoot.removeEventListener("drop", onDrop);
      hoverRoot.removeEventListener("dragend", onDragEnd);
    };
  }, [editor, locateBlock, clearHideTimer, scheduleHide]);

  // 菜单打开时点击外部或 Escape 关闭；Escape 把焦点还给菜单按钮。
  useEffect(() => {
    if (!menuOpen) {
      setMenuUp(false);
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  // 打开菜单后：按剩余空间决定展开方向，并聚焦首项使方向键立即可用
  // （ui-spec 可访问性要求：菜单可用方向键、Enter、Escape 操作）。
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const menu = menuRef.current;
    const root = rootRef.current;
    if (!menu || !root) return;
    const rootRect = root.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rootRect.bottom - 8;
    const spaceAbove = rootRect.top - 8;
    if (menu.offsetHeight > spaceBelow && spaceAbove > spaceBelow) {
      setMenuUp(true);
    }
    menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [menuOpen]);

  // 菜单内 roving focus：方向键循环移动，Home/End 跳到两端；
  // Enter 由原生 button 处理为点击，无需额外分支。
  const onMenuKeyDown = (event: ReactKeyboardEvent) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (i: number) => items[(i + items.length) % items.length]?.focus();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusAt(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusAt(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusAt(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusAt(items.length - 1);
    }
  };

  if (!handle) {
    // 无悬停块时仍渲染隐藏容器：rootRef 需始终存在，供父级矩形计算与外部点击判断。
    // 拖放指示线独立于把手：拖拽中指针离开行后把手可能已隐藏，指示线仍要显示。
    return (
      <>
        {dropLineTop !== null && (
          <div
            className="block-drop-line"
            style={{ top: dropLineTop }}
            aria-hidden="true"
          />
        )}
        <div ref={rootRef} className="block-handle" style={{ display: "none" }} />
      </>
    );
  }

  const runAction = (action: () => void) => {
    action();
    setMenuOpen(false);
    setHandle(null);
  };

  return (
    <>
      {dropLineTop !== null && (
        <div
          className="block-drop-line"
          style={{ top: dropLineTop }}
          aria-hidden="true"
        />
      )}
      <div
        ref={rootRef}
        className="block-handle"
        style={{ top: handle.top }}
        // 进入把手取消隐藏计时；离开把手且未回到正文时再调度隐藏。
        onMouseEnter={clearHideTimer}
        onMouseLeave={(event) => {
          if (menuOpenRef.current || dragPosRef.current !== null) return;
          const related = event.relatedTarget as Node | null;
          if (related && editor.view.dom.contains(related)) return;
          scheduleHide();
        }}
      >
        <button
          type="button"
          className="block-handle__button"
          aria-label="拖动块"
          title="拖动以移动块"
          draggable
          onDragStart={(event) => {
            // 拖动开始即关菜单，避免拖放途中菜单仍开着。
            setMenuOpen(false);
            dragPosRef.current = handle.blockPos;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", "");
          }}
          onDragEnd={() => {
            dragPosRef.current = null;
            setDropLineTop(null);
            setMenuOpen(false);
          }}
        >
          <IconGrip />
        </button>
        <button
          ref={menuButtonRef}
          type="button"
          className="block-handle__button"
          aria-label="块菜单"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          title="块操作"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <IconPlus />
        </button>

        {menuOpen && (
          <div
            ref={menuRef}
            className={`block-menu${menuUp ? " block-menu--up" : ""}`}
            role="menu"
            aria-label="块操作菜单"
            onKeyDown={onMenuKeyDown}
          >
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
    </>
  );
}
