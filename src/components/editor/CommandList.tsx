import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
} from "react";
import type { SuggestionKeyDownProps } from "@tiptap/suggestion";

export interface CommandListItem {
  id: string;
  title: string;
  subtitle?: string;
  icon?: string | null;
}

export interface CommandListRef {
  onKeyDown(props: SuggestionKeyDownProps): boolean;
}

interface CommandListProps {
  items: CommandListItem[];
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
