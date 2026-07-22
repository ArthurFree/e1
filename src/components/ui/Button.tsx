/**
 * @file 统一按钮原语（R002 §7.9）。
 * 只提供视觉变体与默认 type="button"（避免在表单里误触发提交），
 * 样式实现在 styles/components/buttons.css。
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 视觉变体：主要 / 次要（默认）/ 幽灵 / 危险（仅用于确认阶段）。 */
  variant?: "primary" | "secondary" | "ghost" | "danger";
  children: ReactNode;
}

/**
 * 统一按钮（R002 §7.9）：主要/次要/幽灵/危险四种变体，默认高 32px。
 * 危险样式仅用于确认阶段；同一视图最多一个主要按钮组。
 */
export function Button({ variant = "secondary", className, children, ...rest }: ButtonProps) {
  const classes = ["button", `button--${variant}`, className].filter(Boolean).join(" ");
  return (
    <button type="button" className={classes} {...rest}>
      {children}
    </button>
  );
}
