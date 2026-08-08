/**
 * @file 设置面板：AI 服务（OpenAI 兼容接口）的 endpoint / 模型 / API Key 配置，
 * 以及本地存储用量展示（R004 阶段 6，§6.3/§6.4）。
 * 保存前经 domain/ai.ts 的 validateAIConfig 校验；
 * API Key 只保存在本机 IndexedDB，不进入日志、同步或上报，
 * 未配置时应用不会发起任何外部请求（隐私约束）。
 */

import { useEffect, useState } from "react";
import { usePreferences } from "../state/PreferencesContext";
import { useOverlay } from "../state/OverlayContext";
import { useNavigationState } from "../state/NavigationContext";
import { useAppServices } from "../state/AppServicesProvider";
import { validateAIConfig } from "../domain/ai";
import { revisionContentBytes } from "../domain/revisions";
import {
  STORAGE_WARN_RATIO,
  estimateStorage,
  type StorageEstimateInfo,
} from "../application/services/StorageQuotaService";
import { formatBytes } from "../editor/attachment";
import { Dialog } from "./ui/Dialog";

/** 当前文档版本占用的估算结果；null 表示无选中文档或不展示。 */
interface RevisionUsage {
  count: number;
  bytes: number;
}

/**
 * 设置面板：AI 服务（OpenAI 兼容）配置 + 本地存储用量。
 * API Key 只保存在本机 IndexedDB，不进入日志、同步或上报。
 * 开关状态由 OverlayContext 管理（settingsOpen），故无 onClose 属性。
 */
export function SettingsPanel() {
  const { preferences, setAIConfig } = usePreferences();
  const { closeSettings } = useOverlay();
  const { selectedPageId } = useNavigationState();
  const services = useAppServices();
  const current = preferences.aiConfig;

  const [endpoint, setEndpoint] = useState(current?.endpoint ?? "");
  const [model, setModel] = useState(current?.model ?? "");
  const [apiKey, setApiKey] = useState(current?.apiKey ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // undefined = 读取中；null = 浏览器不支持 Storage API（降级展示）。
  const [storage, setStorage] = useState<
    StorageEstimateInfo | null | undefined
  >(undefined);
  const [revisionUsage, setRevisionUsage] = useState<RevisionUsage | null>(
    null,
  );

  // 本地存储估算（R004 §6.3）：仅在面板打开时读取一次。
  useEffect(() => {
    let cancelled = false;
    void estimateStorage().then((info) => {
      if (!cancelled) setStorage(info);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 当前文档版本占用估算（R004 §6.4）：manual/before-restore 不自动清理，
  // 在设置页展示占用让用户可见。
  useEffect(() => {
    if (!selectedPageId) {
      setRevisionUsage(null);
      return;
    }
    let cancelled = false;
    void services.queries.document
      .listRevisions(selectedPageId)
      .then((list) => {
        if (cancelled) return;
        setRevisionUsage({
          count: list.length,
          bytes: list.reduce(
            (sum, r) => sum + revisionContentBytes(r.contentJson),
            0,
          ),
        });
      })
      .catch(() => {
        if (!cancelled) setRevisionUsage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPageId, services]);

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
        <button
          type="button"
          className="settings-panel__primary"
          onClick={() => void save()}
        >
          保存
        </button>
        {current && (
          <button
            type="button"
            className="settings-panel__clear"
            onClick={() => void clear()}
          >
            清除配置
          </button>
        )}
      </div>

      <p className="settings-panel__note">
        API Key 仅保存在本机
        IndexedDB，不会上传、同步或写入日志；未配置时不会发起任何外部请求。
      </p>

      <div className="settings-panel__section">
        <span className="settings-panel__label">本地存储</span>
        {storage === undefined && (
          <p className="settings-panel__storage">正在读取存储用量…</p>
        )}
        {storage === null && (
          <p className="settings-panel__storage">
            当前浏览器不支持存储用量查询。
          </p>
        )}
        {storage && (
          <>
            <p className="settings-panel__storage">
              已使用 {formatBytes(storage.usage)} / {formatBytes(storage.quota)}
              （{Math.round(storage.usageRatio * 100)}%）
            </p>
            {storage.usageRatio >= STORAGE_WARN_RATIO && (
              // 阈值警告（R004 §6.3）：引导清理而非提供半成品导出入口——
              // 完整数据导出（含附件 Blob）超出本阶段体量，见实施报告取舍说明。
              <p className="settings-panel__storage-warning" role="alert">
                本地存储空间不足，请清理回收站或删除不需要的附件，避免保存失败。
              </p>
            )}
          </>
        )}
        {revisionUsage && (
          <p className="settings-panel__storage">
            当前文档版本历史：{revisionUsage.count} 条，约{" "}
            {formatBytes(revisionUsage.bytes)}
          </p>
        )}
      </div>
    </Dialog>
  );
}
