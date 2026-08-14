/**
 * R007 阶段 2（DSK-04）：Vault 设备级交互状态的 Renderer 客户端。
 *
 * 包装 api.vaultState（userData/vault-state/<vaultId>.json），为仓储层提供：
 * - 会话内缓存：list（知识库/页面列表映射）逐库一次 IPC，之后走内存镜像；
 *   patch 成功后以 Main 返回的合并结果刷新镜像（与落盘状态严格一致）；
 * - transient 仅预览会话短路：不进 IPC、不落盘，get 返回空表、patch 仅
 *   更新内存镜像（重启消失，与 transient 语义一致）；
 * - Stable ID Adoption 迁移：写入时若已知 stableNoteId，同请求清空旧
 *   path:<relativePath> 键；读取由 vaultMapping 以 path 键兜底（见
 *   mapScanEntriesToPages 的 state 参数）。
 *
 * 错误策略：patch 失败原样抛出（与 Web 仓储写失败语义一致——Provider
 * 不回滚 UI 镜像的前提是可感知的失败）；get 失败（VAULT_NOT_FOUND 等）
 * 退化为空表并告警——读路径不能让状态故障拖垮列表加载。
 */
import {
  createEmptyVaultState,
  type VaultPageStatePatch,
  type VaultState,
} from "../../../shared/ipc/contracts";
import { isTransientVaultId } from "../../application/queries/documentWritePolicy";
import type { E1DesktopAPI } from "./desktopApi";

export class DesktopVaultStateClient {
  private readonly cache = new Map<string, VaultState>();

  constructor(private readonly api: E1DesktopAPI) {}

  /** 读取整库状态（会话内缓存；transient 返回空表）。 */
  async get(vaultId: string): Promise<VaultState> {
    if (isTransientVaultId(vaultId)) {
      return this.cache.get(vaultId) ?? createEmptyVaultState();
    }
    const cached = this.cache.get(vaultId);
    if (cached) return cached;
    try {
      const state = await this.api.vaultState.get(vaultId);
      this.cache.set(vaultId, state);
      return state;
    } catch (err) {
      console.warn(`读取 Vault 交互状态失败（${vaultId}），按空表处理`, err);
      return createEmptyVaultState();
    }
  }

  /** 收藏/取消收藏知识库（favoriteAt 时间戳或 null）。 */
  async setWorkspaceFavorite(
    vaultId: string,
    favoriteAt: number | null,
  ): Promise<void> {
    await this.patch(vaultId, { workspace: { favoriteAt } });
  }

  /**
   * 写单页状态。stableKey 已知时顺带清空 stalePathKey（Adoption 前的
   * path:<relativePath> 键），完成键迁移。
   */
  async patchPage(
    vaultId: string,
    key: string,
    fields: VaultPageStatePatch,
    stalePathKey?: string,
  ): Promise<void> {
    const pages: Record<string, VaultPageStatePatch> = { [key]: fields };
    if (stalePathKey && stalePathKey !== key) {
      pages[stalePathKey] = { favoriteAt: null, lastOpenedAt: null };
    }
    await this.patch(vaultId, { pages });
  }

  private async patch(
    vaultId: string,
    patch: { pages?: Record<string, VaultPageStatePatch>; workspace?: { favoriteAt?: number | null } },
  ): Promise<void> {
    if (isTransientVaultId(vaultId)) {
      this.cache.set(vaultId, mergeInto(this.getCached(vaultId), patch));
      return;
    }
    const merged = await this.api.vaultState.patch({ vaultId, patch });
    this.cache.set(vaultId, merged);
  }

  private getCached(vaultId: string): VaultState {
    return this.cache.get(vaultId) ?? createEmptyVaultState();
  }
}

/** transient 会话的内存合并（与 Main 的合并语义一致）。 */
function mergeInto(
  state: VaultState,
  patch: {
    pages?: Record<string, VaultPageStatePatch>;
    workspace?: { favoriteAt?: number | null };
  },
): VaultState {
  const next: VaultState = {
    version: 1,
    pages: { ...state.pages },
    workspace: { ...state.workspace },
  };
  if (patch.workspace?.favoriteAt !== undefined) {
    next.workspace.favoriteAt = patch.workspace.favoriteAt;
  }
  if (patch.pages) {
    for (const [key, pagePatch] of Object.entries(patch.pages)) {
      const existing = next.pages[key] ?? {
        favoriteAt: null,
        lastOpenedAt: null,
      };
      next.pages[key] = {
        favoriteAt:
          pagePatch.favoriteAt !== undefined
            ? pagePatch.favoriteAt
            : existing.favoriteAt,
        lastOpenedAt:
          pagePatch.lastOpenedAt !== undefined
            ? pagePatch.lastOpenedAt
            : existing.lastOpenedAt,
      };
    }
  }
  return next;
}
