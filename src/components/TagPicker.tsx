/**
 * @file 文档标签选择器：渲染在文档标题下方。
 * 已选标签以 chip 展示、可单独移除；「＋标签」弹出面板支持勾选切换与即时新建，
 * 新建标签的颜色从 TAG_COLORS 轮换分配。点击面板外或 Escape 关闭弹层。
 */

import { useEffect, useRef, useState } from "react";
import { useApp } from "../state/AppState";

/** 新标签的候选颜色，按已有标签数量轮换。 */
export const TAG_COLORS = [
  "#e16259",
  "#dfab01",
  "#0f7b6c",
  "#337ea9",
  "#6940a5",
  "#c4554d",
];

interface TagPickerProps {
  /** 所属文档 ID；标签勾选结果按页面维度写入 pageTags。 */
  pageId: string;
}

/** 文档标签：标题下方展示已选标签 chips，弹层内勾选/新建标签。 */
export function TagPicker({ pageId }: TagPickerProps) {
  const { tags, pageTags, createTag, setPageTags } = useApp();
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const selectedIds = pageTags
    .filter((r) => r.pageId === pageId)
    .map((r) => r.tagId);
  const selected = tags.filter((t) => selectedIds.includes(t.id));

  const toggle = (tagId: string) => {
    const next = selectedIds.includes(tagId)
      ? selectedIds.filter((id) => id !== tagId)
      : [...selectedIds, tagId];
    void setPageTags(pageId, next);
  };

  const submitNew = () => {
    const name = newName.trim();
    if (!name) return;
    setNewName("");
    // 新建成功后直接勾到当前文档上，省去用户再点一次的步骤
    void createTag(name, TAG_COLORS[tags.length % TAG_COLORS.length]).then(
      (tag) => {
        if (tag) void setPageTags(pageId, [...selectedIds, tag.id]);
      },
    );
  };

  return (
    <div className="tag-picker" ref={rootRef}>
      {selected.map((tag) => (
        <span key={tag.id} className="tag-chip" style={{ color: tag.color }}>
          <span className="tag-chip__dot" style={{ background: tag.color }} />
          {tag.name}
          <button
            type="button"
            className="tag-chip__remove"
            aria-label={`移除标签「${tag.name}」`}
            onClick={() => toggle(tag.id)}
          >
            ✕
          </button>
        </span>
      ))}
      <button
        type="button"
        className="tag-chip tag-chip--add"
        aria-label="添加标签"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        🏷 标签
      </button>
      {open && (
        <div className="tag-picker__panel" role="menu" aria-label="标签列表">
          {tags.length === 0 && (
            <div className="tag-picker__empty">还没有标签，先在下方新建。</div>
          )}
          {tags.map((tag) => {
            const checked = selectedIds.includes(tag.id);
            return (
              <button
                key={tag.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={checked}
                className="tag-picker__item"
                onClick={() => toggle(tag.id)}
              >
                <span className="tag-chip__dot" style={{ background: tag.color }} />
                <span className="tag-picker__name">{tag.name}</span>
                {checked && <span aria-hidden="true">✓</span>}
              </button>
            );
          })}
          <div className="tag-picker__new">
            <input
              aria-label="新建标签名称"
              placeholder="新建标签…"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitNew();
              }}
            />
            <button
              type="button"
              className="icon-button"
              aria-label="创建标签"
              disabled={!newName.trim()}
              onClick={submitNew}
            >
              ＋
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
