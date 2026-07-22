import { useState } from "react";
import type { PickerTarget } from "../domain/picker";
import { jsonToText, markdownToJson } from "../editor/markdown";
import { createOpenAICompatibleProvider } from "../infrastructure/aiProvider";
import { contentRepository, pageRepository } from "../infrastructure/repositories";
import { useApp } from "../state/AppState";
import { Dialog } from "./ui/Dialog";
import { TargetPicker } from "./TargetPicker";

interface AIDraftModalProps {
  onClose(): void;
}

/** 首批文档类型提示词。 */
const DRAFT_TYPES = ["自由写作", "方案", "总结", "周报", "会议纪要"] as const;

type Step = "input" | "generating" | "preview" | "error";

/**
 * AI 帮你写：输入主题、选择类型与位置 → 生成预览 → 确认后才创建文档。
 * 取消或关闭不产生任何文档。
 */
export function AIDraftModal({ onClose }: AIDraftModalProps) {
  const { preferences, openDocument, openSettings } = useApp();
  const [topic, setTopic] = useState("");
  const [draftType, setDraftType] = useState<string>(DRAFT_TYPES[0]);
  const [target, setTarget] = useState<PickerTarget | null>(null);
  const [step, setStep] = useState<Step>("input");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");

  const config = preferences.aiConfig;
  if (!config) {
    // 防御：未配置时不应到达此流程（开始页已拦截），回退到设置。
    return (
      <Dialog label="AI 帮你写" className="modal" onClose={onClose}>
        <h2 className="modal__title">AI 帮你写</h2>
          <p className="modal__hint">需要先在设置中配置兼容的 AI 服务。</p>
          <div className="modal__actions">
            <button type="button" className="button" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={() => {
                onClose();
                openSettings();
              }}
            >
              前往设置
            </button>
          </div>
      </Dialog>
    );
  }

  const generate = async () => {
    setStep("generating");
    setError("");
    try {
      const provider = createOpenAICompatibleProvider(config);
      const result = await provider.complete({
        prompt: topic.trim(),
        mode: "draft",
        draftType,
      });
      setDraft(result);
      setStep("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "AI 请求失败，请稍后再试");
      setStep("error");
    }
  };

  const confirmCreate = async () => {
    if (!target) return;
    const page = await pageRepository.create({
      workspaceId: target.workspaceId,
      parentId: target.parentId,
      kind: "document",
      title: topic.trim() || "无标题",
    });
    // AI 返回的 Markdown 经编辑器白名单解析后落盘。
    const json = markdownToJson(draft);
    await contentRepository.save(page.id, json, jsonToText(json));
    onClose();
    await openDocument(page.id);
  };

  return (
    <Dialog label="AI 帮你写" className="modal modal--wide" onClose={onClose}>
      <h2 className="modal__title">AI 帮你写</h2>
        <div className="modal__form">
          <label className="modal__field">
            <span>主题</span>
            <textarea
              value={topic}
              rows={2}
              aria-label="文档主题"
              placeholder="例如：Q3 产品发布会复盘"
              onChange={(event) => setTopic(event.target.value)}
            />
          </label>
          <label className="modal__field">
            <span>文档类型</span>
            <select
              value={draftType}
              aria-label="文档类型"
              onChange={(event) => setDraftType(event.target.value)}
            >
              {DRAFT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <div className="modal__field">
            <span>创建位置</span>
            <TargetPicker
              className="modal__picker"
              onSelect={(picked) => setTarget(picked)}
            />
            {target && (
              <span className="modal__hint" role="note">
                已选：{target.workspaceName} / {target.parentId ? target.label : "根目录"}
              </span>
            )}
          </div>

          {step === "generating" && <p className="modal__hint">正在生成草稿…</p>}
          {step === "error" && (
            <p className="modal__error" role="alert">
              {error}
            </p>
          )}
          {step === "preview" && (
            <label className="modal__field">
              <span>生成预览（确认后才会写入新文档）</span>
              <textarea
                value={draft}
                rows={10}
                aria-label="AI 生成预览"
                onChange={(event) => setDraft(event.target.value)}
              />
            </label>
          )}

          <div className="modal__actions">
            <button type="button" className="button" onClick={onClose}>
              取消
            </button>
            {step === "preview" && (
              <button type="button" className="button" onClick={() => void generate()}>
                重新生成
              </button>
            )}
            {step !== "preview" ? (
              <button
                type="button"
                className="button button--primary"
                disabled={!topic.trim() || !target || step === "generating"}
                onClick={() => void generate()}
              >
                生成预览
              </button>
            ) : (
              <button
                type="button"
                className="button button--primary"
                onClick={() => void confirmCreate()}
              >
                确认创建
              </button>
            )}
          </div>
        </div>
    </Dialog>
  );
}
