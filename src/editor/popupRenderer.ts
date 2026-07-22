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
  computePosition,
  flip,
  offset,
  shift,
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

  // clientRect 由 suggestion 按光标位置提供；元素挂在 body 下，
  // 用 fixed 等价的绝对坐标定位，避免被编辑器容器的 overflow 裁剪。
  const updatePosition = (clientRect?: (() => DOMRect | null) | null) => {
    if (!element || !clientRect) return;
    const rect = clientRect();
    if (!rect) return;
    const virtual: VirtualElement = { getBoundingClientRect: () => rect };
    void computePosition(virtual, element, {
      placement: "bottom-start",
      middleware: [offset(6), flip(), shift({ padding: 8 })],
    }).then(({ x, y }) => {
      if (!element) return;
      element.style.left = `${x}px`;
      element.style.top = `${y}px`;
    });
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
      updatePosition(props.clientRect);
    },
    onUpdate(props: SuggestionProps<CommandListItem>) {
      renderer?.updateProps({ items: props.items, command: props.command });
      updatePosition(props.clientRect);
    },
    onKeyDown(props: SuggestionKeyDownProps) {
      // Escape 在此消费（返回 true）以关闭弹层，避免冒泡触发编辑器其他快捷键；
      // 其余按键转发给列表组件做上下导航与确认。
      if (props.event.key === "Escape") return true;
      return renderer?.ref?.onKeyDown(props) ?? false;
    },
    onExit() {
      // 建议结束（失焦/确认/Escape）时移除 DOM 并销毁 React 渲染器，防止泄漏。
      element?.remove();
      element = null;
      renderer?.destroy();
      renderer = null;
    },
  };
}

export type { CommandListItem, CommandListRef };
