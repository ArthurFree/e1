/**
 * 本地存储配额（R004 阶段 6，§6.3）测试：
 * estimate 的降级与折算；isQuotaExceededError 的错误分类。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isQuotaExceededError } from "../../domain/errors";
import { estimateStorage } from "./StorageQuotaService";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("estimateStorage", () => {
  it("浏览器不支持 Storage API 时返回 null（降级）", async () => {
    // jsdom 无 navigator.storage。
    expect(await estimateStorage()).toBeNull();
  });

  it("返回用量/配额与占比", async () => {
    vi.stubGlobal("navigator", {
      storage: {
        estimate: () =>
          Promise.resolve({
            usage: 40 * 1024 * 1024,
            quota: 100 * 1024 * 1024,
          }),
      },
    });
    const info = await estimateStorage();
    expect(info?.usage).toBe(40 * 1024 * 1024);
    expect(info?.quota).toBe(100 * 1024 * 1024);
    expect(info?.usageRatio).toBeCloseTo(0.4);
  });

  it("estimate 返回异常值或抛错时降级为 null", async () => {
    vi.stubGlobal("navigator", {
      storage: { estimate: () => Promise.resolve({ usage: 1, quota: 0 }) },
    });
    expect(await estimateStorage()).toBeNull();

    vi.stubGlobal("navigator", {
      storage: {
        estimate: () => Promise.reject(new Error("boom")),
      },
    });
    expect(await estimateStorage()).toBeNull();
  });
});

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
