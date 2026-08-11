/**
 * R006-C2.1（FR-01，r006-c3 §8.2）：目录选择授权令牌存储。
 *
 * SEC-01：Renderer 不允许传任意 absolutePath 作为 Vault 授权。用户经原生
 * 对话框选中目录后，Main 签发不可预测的一次性令牌（crypto.randomUUID），
 * Renderer 只能凭令牌调 vault:openSelection 消费这次授权：
 * - 单次消费：consume 即删，重复使用抛 SELECTION_INVALID；
 * - 5 分钟过期：过期消费抛 SELECTION_EXPIRED（同时清除）；
 * - 伪造/不存在的令牌抛 SELECTION_INVALID；
 * - 进程内存 Map：应用退出立即失效，不落盘。
 *
 * 时钟可注入（测试过期分支用）。
 */
import { randomUUID } from "node:crypto";
import { IpcFailure } from "../../shared/errors.js";

/** 挂起中的目录选择：令牌 → 真实绝对路径（只存在于 Main 进程）。 */
export interface PendingDirectorySelection {
  absolutePath: string;
  createdAt: number;
}

/** 令牌有效期：5 分钟（r006-c3 §8.2 建议值）。 */
export const SELECTION_TOKEN_TTL_MS = 5 * 60 * 1000;

export class SelectionTokenStore {
  private readonly pending = new Map<string, PendingDirectorySelection>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** 为一次原生目录选择签发令牌。 */
  issue(absolutePath: string): string {
    const token = randomUUID();
    this.pending.set(token, { absolutePath, createdAt: this.now() });
    return token;
  }

  /**
   * 消费令牌（先验后取，消费即删——即使过期也已删除，不可重试）。
   * 成功返回该次选择的真实绝对路径。
   */
  consume(token: string): string {
    const entry = this.pending.get(token);
    if (!entry) {
      throw new IpcFailure(
        "SELECTION_INVALID",
        "目录选择授权无效或已被使用，请重新选择文件夹。",
      );
    }
    this.pending.delete(token);
    if (this.now() - entry.createdAt > SELECTION_TOKEN_TTL_MS) {
      throw new IpcFailure(
        "SELECTION_EXPIRED",
        "目录选择授权已过期，请重新选择文件夹。",
      );
    }
    return entry.absolutePath;
  }
}
