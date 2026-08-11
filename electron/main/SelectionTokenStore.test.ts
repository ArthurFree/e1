// @vitest-environment node
/**
 * R006-C2.1（FR-01，r006-c3 §41.1）：SelectionTokenStore 测试。
 * 覆盖：正常签发/消费、单次使用（重复使用失败）、随机伪造、不存在、
 * 过期（注入时钟）；取消选择与 initialized/uninitialized 分流属
 * IPC 层，见 ipc/vault.test.ts。
 */
import { describe, expect, it } from "vitest";
import { IpcFailure } from "../../shared/errors.js";
import {
  SELECTION_TOKEN_TTL_MS,
  SelectionTokenStore,
} from "./SelectionTokenStore.js";

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(IpcFailure);
  expect((error as IpcFailure).code).toBe(code);
}

describe("SelectionTokenStore", () => {
  it("正常令牌：签发后 consume 返回原绝对路径", () => {
    const store = new SelectionTokenStore();
    const token = store.issue("/Users/x/我的笔记");
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.consume(token)).toBe("/Users/x/我的笔记");
  });

  it("单次使用：consume 后令牌立即失效（重复使用 → SELECTION_INVALID）", () => {
    const store = new SelectionTokenStore();
    const token = store.issue("/a");
    store.consume(token);
    try {
      store.consume(token);
      throw new Error("应抛 SELECTION_INVALID");
    } catch (error) {
      expectCode(error, "SELECTION_INVALID");
    }
  });

  it("随机伪造令牌 → SELECTION_INVALID", () => {
    const store = new SelectionTokenStore();
    store.issue("/a");
    try {
      store.consume("00000000-0000-0000-0000-000000000000");
      throw new Error("应抛 SELECTION_INVALID");
    } catch (error) {
      expectCode(error, "SELECTION_INVALID");
    }
  });

  it("从未签发任何令牌时消费 → SELECTION_INVALID", () => {
    const store = new SelectionTokenStore();
    try {
      store.consume("不存在的令牌");
      throw new Error("应抛 SELECTION_INVALID");
    } catch (error) {
      expectCode(error, "SELECTION_INVALID");
    }
  });

  it("过期：签发超过 5 分钟后消费 → SELECTION_EXPIRED（注入时钟）", () => {
    let now = 1_000_000;
    const store = new SelectionTokenStore(() => now);
    const token = store.issue("/a");
    now += SELECTION_TOKEN_TTL_MS + 1;
    try {
      store.consume(token);
      throw new Error("应抛 SELECTION_EXPIRED");
    } catch (error) {
      expectCode(error, "SELECTION_EXPIRED");
    }
  });

  it("过期消费同样单次化：过期令牌不可再次消费", () => {
    let now = 0;
    const store = new SelectionTokenStore(() => now);
    const token = store.issue("/a");
    now += SELECTION_TOKEN_TTL_MS + 1;
    expect(() => store.consume(token)).toThrowError(/过期/);
    try {
      store.consume(token);
      throw new Error("应抛 SELECTION_INVALID");
    } catch (error) {
      expectCode(error, "SELECTION_INVALID");
    }
  });

  it("令牌互不混淆：各自指向各自的绝对路径", () => {
    const store = new SelectionTokenStore();
    const a = store.issue("/a");
    const b = store.issue("/b");
    expect(store.consume(b)).toBe("/b");
    expect(store.consume(a)).toBe("/a");
  });
});
