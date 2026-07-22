import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  hint?: string;
  action?: ReactNode;
}

/** 统一空态（R002 §7.11）：标题 + 单句说明 + 可选主操作。 */
export function EmptyState({ title, hint, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <p className="empty-state__title">{title}</p>
      {hint && <p className="empty-state__hint">{hint}</p>}
      {action}
    </div>
  );
}
