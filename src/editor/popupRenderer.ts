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

/** / 与 @ 共用的浮层渲染：ReactRenderer + floating-ui 定位。 */
export function createPopupRenderer(
  getEditor: () => Editor,
  component: ComponentType<ListComponentProps & { ref?: Ref<CommandListRef> }>,
) {
  let renderer: ReactRenderer<CommandListRef, ListComponentProps> | null = null;
  let element: HTMLElement | null = null;

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
      if (props.event.key === "Escape") return true;
      return renderer?.ref?.onKeyDown(props) ?? false;
    },
    onExit() {
      element?.remove();
      element = null;
      renderer?.destroy();
      renderer = null;
    },
  };
}

export type { CommandListItem, CommandListRef };
