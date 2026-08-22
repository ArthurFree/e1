/**
 * R007 阶段 3（r007 §3.3）：外部 Vault 变更 → 页面树刷新桥。
 *
 * 仅当运行时具备 fileWatching 能力且装配了 externalVaultChanges 服务
 * （Desktop；DUAL-01 只判断能力与服务存在性）时订阅外部变更流：
 * 收到 vaultId 命中当前知识库的批次时，经 Workspace 命令域
 * refreshCurrentWorkspace 重读页面/标签镜像（扫描快照已由
 * reconciliation 服务重扫，刷新直接命中新缓存）。
 *
 * desktop 端 workspace.id 即 vaultId（vaultMapping.mapRecentVaultToWorkspace
 * / mapOpenedVaultToWorkspace 均以 vaultId 为 Workspace.id），直接等值比较。
 * modified 同样触发刷新：外部修改可能改了 Frontmatter 标题/标签，
 * 树镜像需随之更新；当前打开文档的重载/冲突由文档层（§3.4）另行处理。
 */
import { useEffect } from "react";
import { useAppServices } from "../../state/AppServicesProvider";
import {
  useWorkspaceCommands,
  useWorkspaceData,
} from "../../state/WorkspaceSessionContext";

/** 无渲染桥组件：挂载在 AppProviders 之内、AppShell 旁。 */
export function ExternalVaultChangeBridge() {
  const services = useAppServices();
  const { workspace } = useWorkspaceData();
  const { refreshCurrentWorkspace } = useWorkspaceCommands();
  const service = services.externalVaultChanges;
  const enabled = services.capabilities.fileWatching && service !== undefined;
  const vaultId = workspace?.id ?? null;

  useEffect(() => {
    if (!enabled || !service || vaultId === null) return;
    // R008 Stage 5（§11.5）：打开 Vault 自动确保全文索引（missing → 重建，
    // 期间搜索回退标题索引，页面树与编辑器先用不阻断）。
    void services.fullTextSearch?.prepare(vaultId);
    return service.subscribe((changes) => {
      // 任意命中当前库的变更都刷新树镜像：结构性变更（created/moved/
      // deleted）改变树形状，modified 可能携带外部改过的标题/标签。
      if (changes.some((change) => change.vaultId === vaultId)) {
        void refreshCurrentWorkspace();
      }
    });
  }, [enabled, service, vaultId, refreshCurrentWorkspace, services]);

  return null;
}
