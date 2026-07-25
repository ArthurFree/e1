/**
 * `/` 与 `@` 建议弹层共用的渲染器（编辑器内核与 React 组件之间的桥）。
 * 用 ReactRenderer 把命令列表组件挂到 document.body，
 * 用 floating-ui 按光标位置（clientRect 虚拟元素）定位浮层，
 * 并处理键盘事件转发与卸载清理。
 */
import { ReactRenderer } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import type {
  SuggestionKeyDownProps,
  SuggestionProps,
} from "@tiptap/suggestion";
import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
  size,
  type VirtualElement,
} from "@floating-ui/dom";
import {
  type CommandListItem,
  type CommandListRef,
} from "../components/editor/CommandList";
import type { ComponentType, Ref } from "react";

interface ListComponentProps {
  items: CommandListItem[];
  command(item: CommandListItem): void;
}

/** `/` 与 `@` 共用的浮层渲染：ReactRenderer + floating-ui 定位。 */
export function createPopupRenderer(
  getEditor: () => Editor,
  component: ComponentType<ListComponentProps & { ref?: Ref<CommandListRef> }>,
) {
  let renderer: ReactRenderer<CommandListRef, ListComponentProps> | null = null;
  let element: HTMLElement | null = null;
  // autoUpdate 的取消函数：内容渲染后高度才确定，且滚动/缩放会改变光标
  // 位置，一次性 computePosition 会用过期尺寸判断 flip，导致浮层溢出视口。
  let stopAutoUpdate: (() => void) | null = null;
  let latestClientRect: (() => DOMRect | null) | null = null;

  // clientRect 由 suggestion 按光标位置提供；元素挂在 body 下，
  // 用 fixed 等价的绝对坐标定位，避免被编辑器容器的 overflow 裁剪。
  const reposition = () => {
    if (!element || !latestClientRect) return;
    const rect = latestClientRect();
    if (!rect) return;
    const virtual: VirtualElement = { getBoundingClientRect: () => rect };
    void computePosition(virtual, element, {
      placement: "bottom-start",
      middleware: [
        offset(6),
        flip({ padding: 8 }),
        shift({ padding: 8 }),
        // 上下都放不下时压缩列表高度，保证浮层始终完整可见。
        // 只收紧不放宽：以样式表里的 max-height 为上限（首次清掉 inline 后读取并缓存）。
        size({
          padding: 8,
          apply({ availableHeight, elements }) {
            const list = elements.floating.firstElementChild;
            if (!(list instanceof HTMLElement)) return;
            if (!list.dataset.baseMaxHeight) {
              list.style.maxHeight = "";
              const cssMax = Number.parseFloat(getComputedStyle(list).maxHeight);
              list.dataset.baseMaxHeight = String(
                Number.isFinite(cssMax) ? cssMax : 320,
              );
            }
            const base = Number(list.dataset.baseMaxHeight);
            list.style.maxHeight = `${Math.max(120, Math.min(availableHeight, base))}px`;
          },
        }),
      ],
    }).then(({ x, y }) => {
      if (!element) return;
      element.style.left = `${x}px`;
      element.style.top = `${y}px`;
    });
  };

  const trackPosition = (clientRect?: (() => DOMRect | null) | null) => {
    if (!element || !clientRect) return;
    latestClientRect = clientRect;
    if (!stopAutoUpdate) {
      // 虚拟参考始终读 latestClientRect，避免闭包捕获 onStart 时的过期矩形；
      // autoUpdate 靠 ResizeObserver 在浮层内容渲染变高后再次调用 reposition，
      // 才能用真实高度正确 flip / size。
      const virtual: VirtualElement = {
        getBoundingClientRect: () =>
          latestClientRect?.() ?? new DOMRect(),
      };
      stopAutoUpdate = autoUpdate(virtual, element, reposition);
    } else {
      reposition();
    }
  };

  return {
    onStart(props: SuggestionProps<CommandListItem>) {
      renderer = new ReactRenderer(component, {
        editor: getEditor(),
        props: { items: props.items, command: props.command },
      });
      element = renderer.element as HTMLElement;
      element.style.position = "absolute";
      element.style.zIndex = "50";
      document.body.appendChild(element);
      trackPosition(props.clientRect);
    },
    onUpdate(props: SuggestionProps<CommandListItem>) {
      renderer?.updateProps({ items: props.items, command: props.command });
      trackPosition(props.clientRect);
    },
    onKeyDown(props: SuggestionKeyDownProps) {
      // Escape 在此消费（返回 true）以关闭弹层，避免冒泡触发编辑器其他快捷键；
      // 其余按键转发给列表组件做上下导航与确认。
      if (props.event.key === "Escape") return true;
      return renderer?.ref?.onKeyDown(props) ?? false;
    },
    onExit() {
      // 建议结束（失焦/确认/Escape）时移除 DOM 并销毁 React 渲染器，防止泄漏。
      stopAutoUpdate?.();
      stopAutoUpdate = null;
      latestClientRect = null;
      element?.remove();
      element = null;
      renderer?.destroy();
      renderer = null;
    },
  };
}

export type { CommandListItem, CommandListRef };
