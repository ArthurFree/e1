/**
 * @file 统一空态原语（R002 §7.11）：标题 + 单句说明 + 可选主操作。
 * 列表为空、面板无数据等场景统一使用，避免各处自造空态样式。
 */

import type { ReactNode } from "react";

interface EmptyStateProps {
  /** 空态主标题（一句话说明「这里为什么空」）。 */
  title: string;
  /** 可选的补充引导语。 */
  hint?: string;
  /** 可选的主操作区（通常是引导下一步的按钮）。 */
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
