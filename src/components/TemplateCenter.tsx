/**
 * @file 模板中心弹窗：本地内置模板（editor/templates.ts），全程不访问网络。
 * 两步流程：选择模板 → 用 TargetPicker 选择目标知识库 / 分组 →
 * 以模板内容为初稿创建一篇普通文档并打开；取消或关闭不产生任何文档。
 * 创建出的文档与模板无关联，后续修改不影响模板本身。
 */

import { useState } from "react";
import { jsonToText } from "../editor/markdown";
import { DOC_TEMPLATES, type DocTemplate } from "../editor/templates";
import type { PickerTarget } from "../domain/picker";
import { contentRepository, pageRepository } from "../infrastructure/repositories";
import { useApp } from "../state/AppState";
import { Dialog } from "./ui/Dialog";
import { TargetPicker } from "./TargetPicker";

interface TemplateCenterProps {
  /** 关闭弹窗（取消、创建完成后均触发）。 */
  onClose(): void;
}

/**
 * 模板中心：本地内置模板，不访问网络。
 * 选择模板 → 选择目标知识库/分组 → 创建副本并打开；取消不产生任何文档。
 */
export function TemplateCenter({ onClose }: TemplateCenterProps) {
  const { workspaces, openDocument } = useApp();
  const [selected, setSelected] = useState<DocTemplate | null>(null);

  const createFromTemplate = async (template: DocTemplate, target: PickerTarget) => {
    const page = await pageRepository.create({
      workspaceId: target.workspaceId,
      parentId: target.parentId,
      kind: "document",
      title: template.id === "blank" ? "无标题" : template.name,
    });
    await contentRepository.save(page.id, template.content, jsonToText(template.content));
    onClose();
    await openDocument(page.id);
  };

  return (
    <Dialog label="模板中心" className="modal modal--wide" onClose={onClose}>
      {selected === null ? (
        <>
          <h2 className="modal__title">模板中心</h2>
          {workspaces.length === 0 && (
            <p className="start-page__notice" role="note">
              可浏览模板；创建前请先「新建知识库」。
            </p>
          )}
          <div className="template-grid">
            {DOC_TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                className="template-card"
                disabled={workspaces.length === 0}
                onClick={() => setSelected(template)}
              >
                <span className="template-card__name">{template.name}</span>
                <span className="template-card__purpose">{template.purpose}</span>
                <span className="template-card__preview">{template.preview}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <h2 className="modal__title">选择创建位置</h2>
          <p className="modal__hint">
            模板「{selected.name}」将创建为普通文档，与模板无关联。
          </p>
          <TargetPicker
            className="modal__picker"
            onSelect={(target) => void createFromTemplate(selected, target)}
          />
          <div className="modal__actions">
            <button type="button" className="button" onClick={() => setSelected(null)}>
              返回模板列表
            </button>
            <button type="button" className="button" onClick={onClose}>
              取消
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
