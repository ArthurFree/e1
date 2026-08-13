/**
 * R006-C2.1（FR-01，r006-c3 §8.2）：目录选择授权令牌存储。
 *
 * 内部复用 CapabilityTokenStore（R006-C5），对外语义不变：
 * 单次消费、5 分钟过期、伪造无效、进程内存。
 */
import {
  CAPABILITY_TOKEN_TTL_MS,
  CapabilityTokenStore,
} from "./CapabilityTokenStore.js";

export { CAPABILITY_TOKEN_TTL_MS as SELECTION_TOKEN_TTL_MS };

/** 挂起中的目录选择：令牌 → 真实绝对路径（只存在于 Main 进程）。 */
export interface PendingDirectorySelection {
  absolutePath: string;
  createdAt: number;
}

export class SelectionTokenStore {
  private readonly inner: CapabilityTokenStore<string>;

  constructor(now: () => number = () => Date.now()) {
    this.inner = new CapabilityTokenStore(now);
  }

  /** 为一次原生目录选择签发令牌。 */
  issue(absolutePath: string): string {
    return this.inner.issue(absolutePath);
  }

  /**
   * 消费令牌（先验后取，消费即删——即使过期也已删除，不可重试）。
   * 成功返回该次选择的真实绝对路径。
   */
  consume(token: string): string {
    return this.inner.consume(token, {
      invalid: "目录选择授权无效或已被使用，请重新选择文件夹。",
      expired: "目录选择授权已过期，请重新选择文件夹。",
    });
  }
}
