import { useEffect, useRef, type ReactNode } from "react";

interface DialogProps {
  /** 无障碍名称（aria-label）。 */
  label: string;
  onClose(): void;
  /** 追加到面板元素的类名（尺寸/皮肤变体）。 */
  className?: string;
  children: ReactNode;
}

/**
 * 统一对话框（R002 §7.10）：遮罩点击与 Escape 关闭、
 * 打开时聚焦首个可交互元素、关闭后焦点归还触发元素。
 */
export function Dialog({ label, onClose, className, children }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = ref.current?.querySelector<HTMLElement>(
      "input, textarea, select, button, [tabindex]",
    );
    (target ?? ref.current)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [onClose]);

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        ref={ref}
        className={["dialog", className].filter(Boolean).join(" ")}
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
