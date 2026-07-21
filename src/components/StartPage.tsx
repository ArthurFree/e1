import { useMemo, useState } from "react";
import { isAIConfigured } from "../domain/ai";
import { useApp } from "../state/AppState";
import { ActivityList } from "./ActivityList";
import { TargetPicker } from "./TargetPicker";
import { CreateWorkspaceModal } from "./CreateWorkspaceModal";
import { TemplateCenter } from "./TemplateCenter";
import { AIDraftModal } from "./AIDraftModal";

interface StartPageProps {
  onOpenTree(): void;
}

/** 全局“开始”首页：快速操作卡片 + 跨知识库文档活动区。 */
export function StartPage({ onOpenTree }: StartPageProps) {
  const { workspaces, preferences, createDocumentIn, openSettings } = useApp();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [createWsOpen, setCreateWsOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [aiDraftOpen, setAiDraftOpen] = useState(false);

  const recentWorkspace = useMemo(
    () =>
      workspaces
        .filter((w) => w.lastOpenedAt !== null)
        .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))[0] ?? null,
    [workspaces],
  );
  const aiConfigured = isAIConfigured(preferences.aiConfig);

  const quickCreate = () => {
    // 没有最近使用的知识库时必须先选择目标。
    if (recentWorkspace) void createDocumentIn(recentWorkspace.id, null);
    else setPickerOpen(true);
  };

  const openAI = () => {
    // 未配置 AI 时打开设置面板并说明；已配置时进入新建 AI 文档流程。
    if (aiConfigured) setAiDraftOpen(true);
    else openSettings();
  };

  return (
    <div className="start-page">
      <div className="start-page__inner">
        <header className="start-page__header">
          <button
            type="button"
            className="icon-button tree-toggle"
            aria-label="打开文档树"
            onClick={onOpenTree}
          >
            ☰
          </button>
          <h1 className="start-page__title">开始</h1>
        </header>

        <section className="quick-cards" aria-label="快速操作">
          <div className="quick-card quick-card--split">
            <button
              type="button"
              className="quick-card__main"
              disabled={workspaces.length === 0}
              onClick={quickCreate}
            >
              <span className="quick-card__icon" aria-hidden="true">📄</span>
              <span className="quick-card__name">新建文档</span>
              <span className="quick-card__hint">
                {recentWorkspace ? `在「${recentWorkspace.name}」创建` : "选择知识库创建"}
              </span>
            </button>
            <button
              type="button"
              className="quick-card__caret"
              aria-label="选择目标知识库或分组"
              aria-expanded={pickerOpen}
              disabled={workspaces.length === 0}
              onClick={() => setPickerOpen((open) => !open)}
            >
              ▾
            </button>
            {pickerOpen && (
              <TargetPicker
                onSelect={(target) => {
                  setPickerOpen(false);
                  void createDocumentIn(target.workspaceId, target.parentId);
                }}
              />
            )}
          </div>

          <button
            type="button"
            className="quick-card"
            onClick={() => setCreateWsOpen(true)}
          >
            <span className="quick-card__icon" aria-hidden="true">📚</span>
            <span className="quick-card__name">新建知识库</span>
            <span className="quick-card__hint">名称必填，可选图标与描述</span>
          </button>

          <button
            type="button"
            className="quick-card"
            onClick={() => setTemplatesOpen(true)}
          >
            <span className="quick-card__icon" aria-hidden="true">🧩</span>
            <span className="quick-card__name">模板中心</span>
            <span className="quick-card__hint">会议纪要、周报等内置模板</span>
          </button>

          <button
            type="button"
            className="quick-card"
            title={aiConfigured ? "从主题生成文档草稿" : "先在设置中配置 AI 服务"}
            onClick={openAI}
          >
            <span className="quick-card__icon" aria-hidden="true">✨</span>
            <span className="quick-card__name">AI 帮你写</span>
            <span className="quick-card__hint">
              {aiConfigured ? "输入主题，生成文档草稿" : "未配置，点击前往设置"}
            </span>
          </button>
        </section>
        {workspaces.length === 0 && (
          <p className="start-page__notice" role="note">
            还没有知识库，请先「新建知识库」，然后再创建文档。
          </p>
        )}

        <ActivityList />
      </div>
      {createWsOpen && <CreateWorkspaceModal onClose={() => setCreateWsOpen(false)} />}
      {templatesOpen && <TemplateCenter onClose={() => setTemplatesOpen(false)} />}
      {aiDraftOpen && <AIDraftModal onClose={() => setAiDraftOpen(false)} />}
    </div>
  );
}
