import { useEffect, useMemo, useState } from "react";
import type { Page } from "../domain/types";
import { buildPickerTargets, type PickerTarget } from "../domain/picker";
import { pageRepository } from "../infrastructure/repositories";
import { useApp } from "../state/AppState";

interface TargetPickerProps {
  onSelect(target: PickerTarget): void;
  /** 额外的 className，默认使用 picker 菜单样式。 */
  className?: string;
}

/** 创建位置选择器：知识库根目录 + 全部分组，跨知识库列出。 */
export function TargetPicker({ onSelect, className }: TargetPickerProps) {
  const { workspaces } = useApp();
  const [allPages, setAllPages] = useState<Page[]>([]);

  useEffect(() => {
    let cancelled = false;
    void pageRepository
      .listAll()
      .then((pages) => {
        if (!cancelled) setAllPages(pages);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const targets = useMemo(
    () => buildPickerTargets(workspaces, allPages),
    [workspaces, allPages],
  );

  return (
    <div className={className ?? "quick-card__picker"} role="menu" aria-label="选择创建位置">
      {targets.map((target) => (
        <button
          key={`${target.workspaceId}:${target.parentId ?? "root"}`}
          type="button"
          role="menuitem"
          className="picker-row"
          style={{ paddingLeft: 12 + target.depth * 16 }}
          onClick={() => onSelect(target)}
        >
          {target.depth > 0 && <span aria-hidden="true">📁 </span>}
          {target.label}
        </button>
      ))}
    </div>
  );
}
