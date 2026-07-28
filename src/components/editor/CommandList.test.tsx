import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import type { SuggestionKeyDownProps } from "@tiptap/suggestion";
import {
  CommandList,
  type CommandListItem,
  type CommandListRef,
} from "./CommandList";

const ITEMS: CommandListItem[] = Array.from({ length: 6 }, (_, i) => ({
  id: `item-${i}`,
  title: `候选 ${i}`,
}));

function keyDown(ref: React.RefObject<CommandListRef | null>, key: string) {
  let handled = false;
  act(() => {
    handled =
      ref.current?.onKeyDown({
        event: new KeyboardEvent("keydown", { key }),
      } as SuggestionKeyDownProps) ?? false;
  });
  return handled;
}

describe("CommandList", () => {
  // jsdom 不实现 scrollIntoView；替换为 spy 以断言滚动跟随行为。
  const scrollIntoView = vi.fn();
  const originalScrollIntoView = Element.prototype.scrollIntoView;

  beforeEach(() => {
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  afterEach(() => {
    cleanup();
    scrollIntoView.mockClear();
    Element.prototype.scrollIntoView = originalScrollIntoView;
  });

  it("方向键移动高亮并保持选中项可见", () => {
    const ref = createRef<CommandListRef>();
    render(<CommandList ref={ref} items={ITEMS} command={vi.fn()} />);

    expect(keyDown(ref, "ArrowDown")).toBe(true);
    const options = screen.getAllByRole("option");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    // 高亮变化后对选中项调用 scrollIntoView（block: nearest）。
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("ArrowUp 从首项环绕到末项且末项滚动可见", () => {
    const ref = createRef<CommandListRef>();
    render(<CommandList ref={ref} items={ITEMS} command={vi.fn()} />);
    scrollIntoView.mockClear();

    expect(keyDown(ref, "ArrowUp")).toBe(true);
    const options = screen.getAllByRole("option");
    expect(options[options.length - 1]).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("Enter 选择当前高亮项", () => {
    const ref = createRef<CommandListRef>();
    const command = vi.fn();
    render(<CommandList ref={ref} items={ITEMS} command={command} />);

    keyDown(ref, "ArrowDown");
    expect(keyDown(ref, "Enter")).toBe(true);
    expect(command).toHaveBeenCalledWith(ITEMS[1]);
  });

  it("Escape 不消费（交还 suggestion 插件关闭浮层）", () => {
    const ref = createRef<CommandListRef>();
    render(<CommandList ref={ref} items={ITEMS} command={vi.fn()} />);
    expect(keyDown(ref, "Escape")).toBe(false);
  });
});
