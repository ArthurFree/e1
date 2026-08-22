/**
 * @file 设置面板：AI 服务（OpenAI 兼容接口）的 endpoint / 模型 / API Key 配置，
 * 以及本地存储用量展示（R004 阶段 6，§6.3/§6.4）。
 * 保存前经 domain/ai.ts 的 validateAIConfig 校验；
 * R005 阶段 8 §8.2：endpoint/model 存偏好记录，API Key 经 SecretStore
 * 存独立 secrets store，只保存在本机，不进入日志、同步或上报，
 * 未配置时应用不会发起任何外部请求（隐私约束）。
 */

import { useEffect, useState } from "react";
import { usePreferences } from "../state/PreferencesContext";
import { useOverlay } from "../state/OverlayContext";
import { useNavigationState } from "../state/NavigationContext";
import {
  useWorkspaceCommands,
  useWorkspaceData,
} from "../state/WorkspaceSessionContext";
import { useAppServices } from "../state/AppServicesProvider";
import { getAISettings, validateAIConfig } from "../domain/ai";
import { AI_API_KEY_SECRET } from "../application/services/SecretStore";
import { revisionContentBytes } from "../domain/revisions";
import {
  STORAGE_WARN_RATIO,
  type StorageEstimateInfo,
} from "../application/services/StorageHealthService";
import { VaultExportService } from "../application/vault/VaultExportService";
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
  const { workspace } = useWorkspaceData();
  const { importVault } = useWorkspaceCommands();
  const services = useAppServices();
  // 非机密 AI 设置来自偏好镜像（R005 阶段 8 §8.2）；apiKey 在 SecretStore。
  const current = getAISettings(preferences);

  const [endpoint, setEndpoint] = useState(current?.endpoint ?? "");
  const [model, setModel] = useState(current?.model ?? "");
  // API Key 输入框不回显明文（type=password 掩码）；初始值经 SecretStore 异步读入。
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // undefined = 读取中；null = 浏览器不支持 Storage API（降级展示）。
  const [storage, setStorage] = useState<
    StorageEstimateInfo | null | undefined
  >(undefined);
  const [revisionUsage, setRevisionUsage] = useState<RevisionUsage | null>(
    null,
  );
  // Portable Vault 导出（R005 阶段 7A）：进行中禁用按钮，结果一行提示。
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<string | null>(null);
  // Portable Vault 导入（R005 阶段 7B）：同上，一行摘要 + console 明细。
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);

  // 本地存储估算（R004 §6.3；R005 阶段 8 §8.4 起经 storageHealth port）：
  // 仅在面板打开时读取一次。
  useEffect(() => {
    let cancelled = false;
    void services.storageHealth.estimate().then((info) => {
      if (!cancelled) setStorage(info);
    });
    return () => {
      cancelled = true;
    };
  }, [services]);

  // 已保存的 API Key 经 SecretStore 读入掩码输入框（保持既有「不回显明文」的交互）。
  useEffect(() => {
    let cancelled = false;
    void services.secretStore.get(AI_API_KEY_SECRET).then((key) => {
      if (!cancelled && key !== null) setApiKey(key);
    });
    return () => {
      cancelled = true;
    };
  }, [services]);

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

  // 导出当前知识库为 Portable Vault（.e1.zip，R005 阶段 7A）。
  // 服务只返回 zip 字节；下载沿用现有 createObjectURL + a[download] 方式。
  const exportVault = async () => {
    if (!workspace || exporting) return;
    setExporting(true);
    setExportResult(null);
    try {
      const service = new VaultExportService({
        workspaceQuery: services.queries.workspace,
        documentQuery: services.queries.document,
        assetAccess: services.assets.access,
      });
      const result = await service.exportWorkspace(workspace.id);
      const blob = new Blob([result.data.buffer as ArrayBuffer], {
        type: "application/zip",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
      const { noteCount, assetCount, skippedTrashCount } = result.summary;
      setExportResult(
        `已导出 ${noteCount} 篇文档、${assetCount} 个附件` +
          (skippedTrashCount > 0
            ? `（回收站 ${skippedTrashCount} 页未导出）`
            : "") +
          "。",
      );
      // 与单文档导出一致：有损明细先经 console.warn 暴露。
      if (result.summary.lossy) {
        console.warn("本次导出含有损转换：", result.summary.unsupported);
      }
    } catch (err) {
      services.assets.notify.notify(
        `导出知识库失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setExporting(false);
    }
  };

  // 导入 Portable Vault（.e1.zip，R005 阶段 7B）：文件选择走资源选择器
  // 通道（accept 限定 zip），导入编排在 WorkspaceProvider 的 importVault
  // 命令内（含知识库列表镜像刷新与切换），失败经 notify 通道反馈。
  const importVaultFile = async () => {
    if (importing) return;
    setImporting(true);
    setImportResult(null);
    try {
      const picked = await services.assets.picker.pick({
        accept: ".zip,application/zip",
      });
      if (!picked) return; // 用户取消选择
      const bytes =
        picked.source.kind === "bytes" ? picked.source.data : undefined;
      if (!bytes) {
        services.assets.notify.notify(
          "无法读取所选文件，请重新选择一个 .e1.zip。",
        );
        return;
      }
      const report = await importVault(bytes);
      setImportResult(
        `已导入到「${report.workspaceName}」：${report.importedCount} 篇文档` +
          (report.skipped.length > 0
            ? `、跳过 ${report.skipped.length} 篇`
            : "") +
          (report.missingAssets.length > 0
            ? `、${report.missingAssets.length} 个附件缺失`
            : "") +
          (report.unresolvedLinks.length > 0
            ? `、${report.unresolvedLinks.length} 个链接未解析`
            : "") +
          (report.lossy ? "（含有损转换）" : "") +
          "。",
      );
      // 与导出一致：报告明细（skipped/unsupported 等）先经 console 暴露。
      if (report.lossy || report.skipped.length > 0) {
        console.warn("本次导入的报告明细：", report);
      }
    } catch (err) {
      services.assets.notify.notify(
        `导入知识库失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setImporting(false);
    }
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

      {services.secretStorageStatus &&
        !services.secretStorageStatus.persistent && (
          <div className="settings-panel__error" role="alert">
            系统安全存储不可用，API Key 仅保存在本次会话（重启后需重新填写）。
          </div>
        )}

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
        {services.secretStorageStatus
          ? services.secretStorageStatus.persistent
            ? "API Key 仅保存在本机系统安全存储，不会上传、同步或写入日志；未配置时不会发起任何外部请求。"
            : "API Key 不会上传、同步或写入日志；未配置时不会发起任何外部请求。"
          : "API Key 仅保存在本机 IndexedDB，不会上传、同步或写入日志；未配置时不会发起任何外部请求。"}
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
        {/* Portable Vault 导出/导入（R005 阶段 7A/7B）：知识库级备份通道。 */}
        <div className="settings-panel__actions">
          <button
            type="button"
            className="settings-panel__primary"
            disabled={!workspace || exporting}
            onClick={() => void exportVault()}
          >
            {exporting ? "正在导出…" : "导出知识库（.e1.zip）"}
          </button>
          <button
            type="button"
            className="settings-panel__secondary"
            disabled={importing}
            onClick={() => void importVaultFile()}
          >
            {importing ? "正在导入…" : "导入知识库（.e1.zip）"}
          </button>
        </div>
        {exportResult && (
          <p className="settings-panel__storage">{exportResult}</p>
        )}
        {importResult && (
          <p className="settings-panel__storage">{importResult}</p>
        )}
      </div>
    </Dialog>
  );
}
