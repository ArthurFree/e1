/**
 * 领域错误码测试：isQuotaExceededError 的错误分类
 * （断言自原 application/services/StorageQuotaService.test.ts 迁入，
 * R005 阶段 8 §8.4 删除该模块时保留覆盖）。
 */
import { describe, expect, it } from "vitest";
import { isQuotaExceededError } from "./errors";

describe("isQuotaExceededError", () => {
  it("识别 QuotaExceededError（含老实现 code 22）", () => {
    expect(
      isQuotaExceededError(new DOMException("full", "QuotaExceededError")),
    ).toBe(true);
    const legacy = new DOMException("full", "UnknownError");
    Object.defineProperty(legacy, "code", { value: 22 });
    expect(isQuotaExceededError(legacy)).toBe(true);
  });

  it("普通错误不误判", () => {
    expect(isQuotaExceededError(new Error("磁盘已满"))).toBe(false);
    expect(isQuotaExceededError(new DOMException("x", "AbortError"))).toBe(
      false,
    );
    expect(isQuotaExceededError(null)).toBe(false);
  });
});
