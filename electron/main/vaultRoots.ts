/**
 * R006-C2.1（FR-01/FR-02/FR-03）：vaultId → Vault 根目录的双通道解析。
 *
 * 两类 vaultId 来源：
 * - 常规 Vault：VaultRegistry（recent-vaults.json）登记的 vaultId；
 * - transient 仅预览会话：TransientVaultStore（进程内存，FR-03「仅预览」）。
 *
 * vault:scan 与后续 note.read 等所有按 vaultId 寻址的 handler 统一走本
 * 函数，不得各自解析；解析含目录可达性复查（ENOENT → VAULT_NOT_FOUND、
 * EACCES/EPERM → VAULT_PERMISSION_DENIED，经 assertVaultRootDirectory
 * 的 FR-04 分类）。Renderer 全程不接触 absolutePath。
 */
import { IpcFailure } from "../../shared/errors.js";
import { assertVaultRootDirectory } from "./filesystem/VaultFileSystem.js";
import type { TransientVaultStore } from "./transientVaults.js";
import type { VaultRegistry } from "./vaultRegistry.js";

export interface VaultRootResolution {
  absolutePath: string;
  displayName: string;
  /** true：transient 仅预览会话（不进注册表，重启消失）。 */
  transient: boolean;
}

export interface VaultRootDeps {
  registry?: VaultRegistry;
  transients?: TransientVaultStore;
}

/** 解析 vaultId 对应的 Vault 根目录；未登记/不可达抛带码 IpcFailure。 */
export async function resolveVaultRoot(
  vaultId: string,
  deps: VaultRootDeps,
): Promise<VaultRootResolution> {
  // transient 通道优先（transient: 前缀与注册表 id 不可能冲突，顺序仅为明确）。
  const transient = deps.transients?.find(vaultId);
  if (transient) {
    await assertVaultRootDirectory(transient.absolutePath);
    return { ...transient, transient: true };
  }
  const record = await deps.registry?.findByVaultId(vaultId);
  if (!record) {
    throw new IpcFailure(
      "VAULT_NOT_FOUND",
      `vaultId 未登记（请先打开对应知识库）：${vaultId}`,
    );
  }
  await assertVaultRootDirectory(record.absolutePath);
  return {
    absolutePath: record.absolutePath,
    displayName: record.displayName,
    transient: false,
  };
}
