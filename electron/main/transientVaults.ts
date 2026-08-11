/**
 * R006-C2.1（FR-03「仅预览」，r006-c3 §10.2）：transient Vault 会话存储。
 *
 * 用户选择「仅预览」一个未初始化的普通 Markdown 文件夹时，Main 登记一个
 * 仅存在于进程内存的 transient vault：
 * - vaultId 形如 transient:<uuid>，与注册表 vaultId 不可能冲突；
 * - 不写 recent-vaults.json（预览不是「打开过的知识库」，重启即消失）；
 * - scan（及后续 note.read）经 resolveVaultRoot 双通道解析可达；
 * - 写路径在 Renderer 侧整体禁用（写操作全部 NOT_IMPLEMENTED 诚实失败），
 *   Main 侧本批没有任何接受 transient vaultId 的写接口。
 */
import { randomUUID } from "node:crypto";

export interface TransientVault {
  absolutePath: string;
  displayName: string;
}

export class TransientVaultStore {
  private readonly vaults = new Map<string, TransientVault>();

  /** 登记一个仅预览会话，返回 transient vaultId。 */
  add(absolutePath: string, displayName: string): string {
    const vaultId = `transient:${randomUUID()}`;
    this.vaults.set(vaultId, { absolutePath, displayName });
    return vaultId;
  }

  /** 按 vaultId 查 transient 会话；非 transient 或未登记返回 null。 */
  find(vaultId: string): TransientVault | null {
    return this.vaults.get(vaultId) ?? null;
  }
}
