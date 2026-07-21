import { useEffect, useState, type FormEvent } from "react";
import { useApp } from "../state/AppState";

interface CreateWorkspaceModalProps {
  onClose(): void;
}

/** 新建知识库弹窗：必填名称，可选图标与描述；创建后进入知识库首页。 */
export function CreateWorkspaceModal({ onClose }: CreateWorkspaceModalProps) {
  const { createWorkspace } = useApp();
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    void createWorkspace(trimmed, {
      icon: icon.trim() || null,
      description: description.trim(),
    });
    onClose();
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="新建知识库"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="modal__title">新建知识库</h2>
        <form className="modal__form" onSubmit={submit}>
          <label className="modal__field">
            <span>名称（必填）</span>
            <input
              value={name}
              autoFocus
              aria-label="知识库名称"
              placeholder="例如：工作笔记"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="modal__field">
            <span>图标（可选，Emoji）</span>
            <input
              value={icon}
              aria-label="知识库图标"
              placeholder="📚"
              onChange={(event) => setIcon(event.target.value)}
            />
          </label>
          <label className="modal__field">
            <span>描述（可选）</span>
            <textarea
              value={description}
              aria-label="知识库描述"
              rows={3}
              placeholder="这个知识库用来做什么？"
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <div className="modal__actions">
            <button type="button" className="button" onClick={onClose}>
              取消
            </button>
            <button
              type="submit"
              className="button button--primary"
              disabled={!name.trim()}
            >
              创建
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
