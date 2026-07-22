/**
 * 斜杠命令（/）与提及（@）共用的候选列表组件。
 *
 * 由 @tiptap/suggestion 经 editor/popupRenderer 挂载到浮层，通过 ref 暴露
 * onKeyDown 供 suggestion 插件转发键盘事件：方向键循环移动、Enter 选择；
 * 未处理的按键（含 Escape）返回 false，交还插件关闭浮层。
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  type ReactNode,
} from "react";
import type { SuggestionKeyDownProps } from "@tiptap/suggestion";

/** 候选列表项：id 去重与回调用，title 主文案，subtitle/icon 可选补充展示。 */
export interface CommandListItem {
  id: string;
  title: string;
  subtitle?: string;
  icon?: ReactNode;
}

/** 经 ref 暴露给 suggestion 插件的键盘接口；返回 true 表示事件已消费。 */
export interface CommandListRef {
  onKeyDown(props: SuggestionKeyDownProps): boolean;
}

/** CommandList 入参。 */
interface CommandListProps {
  /** 当前过滤后的候选；变化时选中项重置到第一条。 */
  items: CommandListItem[];
  /** 选中（Enter 或点击）某项时由 suggestion 提供的执行回调。 */
  command(item: CommandListItem): void;
}

/** / 与 @ 共用的候选列表：方向键移动、Enter 选择、Escape 关闭。 */
export const CommandList = forwardRef<CommandListRef, CommandListProps>(
  function CommandList({ items, command }, ref) {
    const [selectedIndex, setSelectedIndex] = useState(0);

    useEffect(() => {
      setSelectedIndex(0);
    }, [items]);

    useImperativeHandle(ref, () => ({
      onKeyDown({ event }) {
        if (event.key === "ArrowDown") {
          setSelectedIndex((i) => (items.length ? (i + 1) % items.length : 0));
          return true;
        }
        if (event.key === "ArrowUp") {
          setSelectedIndex((i) =>
            items.length ? (i + items.length - 1) % items.length : 0,
          );
          return true;
        }
        if (event.key === "Enter") {
          const item = items[selectedIndex];
          if (item) command(item);
          return true;
        }
        // 其余按键（含 Escape）不消费，交还 suggestion 插件处理。
        return false;
      },
    }));

    if (items.length === 0) {
      return <div className="command-list command-list--empty">没有匹配的结果</div>;
    }

    return (
      <div className="command-list" role="listbox" aria-label="命令列表">
        {items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={index === selectedIndex}
            className={`command-list__item${
              index === selectedIndex ? " command-list__item--selected" : ""
            }`}
            onMouseEnter={() => setSelectedIndex(index)}
            onClick={() => command(item)}
          >
            {item.icon && (
              <span className="command-list__icon" aria-hidden="true">
                {item.icon}
              </span>
            )}
            <span className="command-list__title">{item.title}</span>
            {item.subtitle && (
              <span className="command-list__subtitle">{item.subtitle}</span>
            )}
          </button>
        ))}
      </div>
    );
  },
);
