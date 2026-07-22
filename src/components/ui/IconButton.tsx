/**
 * @file 统一图标按钮原语（R002 §7.7/§7.8）。
 * 强制要求可读名称 label（同时落到 aria-label 与 title），
 * 保证纯图标按钮的可访问性；激活态通过 aria-pressed 暴露。
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 必填：同时用作 aria-label 与 Tooltip（title）。 */
  label: string;
  /** 选中/激活态（aria-pressed）。 */
  active?: boolean;
  children: ReactNode;
}

/**
 * 统一图标按钮（R002 §7.7/§7.8）：32px 点击区，
 * 必须提供可读名称；激活态有独立视觉。
 */
export function IconButton({ label, active, className, children, ...rest }: IconButtonProps) {
  const classes = [
    "icon-button",
    active ? "icon-button--active" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      className={classes}
      aria-label={label}
      aria-pressed={active ?? false}
      title={label}
      {...rest}
    >
      {children}
    </button>
  );
}
