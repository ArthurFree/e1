/**
 * @file 设置面板：AI 服务（OpenAI 兼容接口）的 endpoint / 模型 / API Key 配置。
 * 保存前经 domain/ai.ts 的 validateAIConfig 校验；
 * API Key 只保存在本机 IndexedDB，不进入日志、同步或上报，
 * 未配置时应用不会发起任何外部请求（隐私约束）。
 */

import { useState } from "react";
import { useApp } from "../state/AppState";
import { validateAIConfig } from "../domain/ai";
import { Dialog } from "./ui/Dialog";

/**
 * 设置面板：AI 服务（OpenAI 兼容）配置。
 * API Key 只保存在本机 IndexedDB，不进入日志、同步或上报。
 * 开关状态由 AppState 管理（settingsOpen），故无 onClose 属性。
 */
export function SettingsPanel() {
  const { preferences, setAIConfig, closeSettings } = useApp();
  const current = preferences.aiConfig;

  const [endpoint, setEndpoint] = useState(current?.endpoint ?? "");
  const [model, setModel] = useState(current?.model ?? "");
  const [apiKey, setApiKey] = useState(current?.apiKey ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    const config = {
      endpoint: endpoint.trim(),
      model: model.trim(),
      apiKey: apiKey.trim(),
    };
    // 校验失败时仅展示错误、不落盘，避免半截配置导致 AI 请求 401/404
    const message = validateAIConfig(config);
    if (message) {
      setError(message);
      setSaved(false);
      return;
    }
    await setAIConfig(config);
    setError(null);
    setSaved(true);
  };

  const clear = async () => {
    await setAIConfig(null);
    setEndpoint("");
    setModel("");
    setApiKey("");
    setError(null);
    setSaved(false);
  };

  return (
    <Dialog label="设置" className="settings-panel" onClose={closeSettings}>
      <div className="dialog__header">
        <span>设置</span>
        <span className="settings-panel__status">
          {current ? "AI 已配置" : "AI 未配置"}
        </span>
      </div>

      <label className="settings-panel__field">
        <span className="settings-panel__label">Endpoint</span>
        <input
          className="settings-panel__input"
          aria-label="Endpoint"
          placeholder="https://api.openai.com/v1"
          value={endpoint}
          onChange={(e) => {
            setEndpoint(e.target.value);
            setSaved(false);
          }}
        />
      </label>
      <label className="settings-panel__field">
        <span className="settings-panel__label">模型</span>
        <input
          className="settings-panel__input"
          aria-label="模型"
          placeholder="gpt-4o-mini"
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            setSaved(false);
          }}
        />
      </label>
      <label className="settings-panel__field">
        <span className="settings-panel__label">API Key</span>
        <input
          className="settings-panel__input"
          aria-label="API Key"
          type="password"
          placeholder="sk-…"
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
            setSaved(false);
          }}
        />
      </label>

      {error && <div className="settings-panel__error">{error}</div>}
      {saved && !error && <div className="settings-panel__saved">已保存。</div>}

      <div className="settings-panel__actions">
        <button type="button" className="settings-panel__primary" onClick={() => void save()}>
          保存
        </button>
        {current && (
          <button type="button" className="settings-panel__clear" onClick={() => void clear()}>
            清除配置
          </button>
        )}
      </div>

      <p className="settings-panel__note">
        API Key 仅保存在本机 IndexedDB，不会上传、同步或写入日志；未配置时不会发起任何外部请求。
      </p>
    </Dialog>
  );
}
