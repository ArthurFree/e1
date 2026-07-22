import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
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
