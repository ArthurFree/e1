/**
 * @file 统一对话框原语（R002 §7.10）：全部弹层面板的基础设施。
 * 提供遮罩点击与 Escape 关闭、打开时自动聚焦首个可交互元素、
 * 关闭后焦点归还触发前的元素；R002 中 8 个面板均已迁移到本组件，
 * 新增弹层应一律复用它而不是自建遮罩。
 */

import { useEffect, useRef, type ReactNode } from "react";

interface DialogProps {
  /** 无障碍名称（aria-label）。 */
  label: string;
  /** 关闭回调：Escape 与遮罩点击都会触发。 */
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
    // 记录触发元素，关闭时归还焦点（键盘用户回到原位继续操作）
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // 优先聚焦首个可交互控件（如输入框），否则聚焦对话框本身
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
