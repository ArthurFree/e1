/**
 * 通用一次性能力令牌（R006-C5 FR-11）：Main 签发、随机不可预测、
 * 单次消费、5 分钟过期、进程内存、退出即失效。
 *
 * 目录选择（SelectionTokenStore）与文件选择（PendingFileSelection）共用本实现。
 */
import { randomUUID } from "node:crypto";
import { IpcFailure } from "../../shared/errors.js";

/** 令牌有效期：5 分钟（与 C2.1 目录选择同口径）。 */
export const CAPABILITY_TOKEN_TTL_MS = 5 * 60 * 1000;

export interface TokenConsumeMessages {
  invalid: string;
  expired: string;
}

export class CapabilityTokenStore<T> {
  private readonly pending = new Map<string, { payload: T; createdAt: number }>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs: number = CAPABILITY_TOKEN_TTL_MS,
  ) {}

  issue(payload: T): string {
    const token = randomUUID();
    this.pending.set(token, { payload, createdAt: this.now() });
    return token;
  }

  consume(token: string, messages: TokenConsumeMessages): T {
    const entry = this.pending.get(token);
    if (!entry) {
      throw new IpcFailure("SELECTION_INVALID", messages.invalid);
    }
    this.pending.delete(token);
    if (this.now() - entry.createdAt > this.ttlMs) {
      throw new IpcFailure("SELECTION_EXPIRED", messages.expired);
    }
    return entry.payload;
  }
}

/** 文件选择授权载荷（R006-C5 FR-12）：绝对路径只存在于 Main。 */
export interface PendingFileSelection {
  absolutePath: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  createdAt: number;
}

export const FILE_TOKEN_MESSAGES: TokenConsumeMessages = {
  invalid: "文件选择授权无效或已被使用，请重新选择文件。",
  expired: "文件选择授权已过期，请重新选择文件。",
};
