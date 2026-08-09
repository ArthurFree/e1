/**
 * StorageHealthService 的 Web 实现测试（R005 阶段 8 §8.4）：
 * estimate 降级与折算（断言自原 StorageQuotaService.test.ts 迁入），
 * 连接生命周期事件的订阅转发（blocked/versionchange/terminated）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StorageConnectionEvent } from "../../application/services/StorageHealthService";
import { WebStorageHealthService } from "./webStorageHealth";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("estimate", () => {
  it("浏览器不支持 Storage API 时返回 null（降级）", async () => {
    // jsdom 无 navigator.storage。
    const service = new WebStorageHealthService();
    expect(await service.estimate()).toBeNull();
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
    const service = new WebStorageHealthService();
    const info = await service.estimate();
    expect(info?.usage).toBe(40 * 1024 * 1024);
    expect(info?.quota).toBe(100 * 1024 * 1024);
    expect(info?.usageRatio).toBeCloseTo(0.4);
  });

  it("estimate 返回异常值或抛错时降级为 null", async () => {
    vi.stubGlobal("navigator", {
      storage: { estimate: () => Promise.resolve({ usage: 1, quota: 0 }) },
    });
    expect(await new WebStorageHealthService().estimate()).toBeNull();

    vi.stubGlobal("navigator", {
      storage: {
        estimate: () => Promise.reject(new Error("boom")),
      },
    });
    expect(await new WebStorageHealthService().estimate()).toBeNull();
  });
});

describe("连接生命周期事件订阅", () => {
  it("emitConnectionEvent 转发给订阅者，退订后不再收到", () => {
    const service = new WebStorageHealthService();
    const received: StorageConnectionEvent[] = [];
    const unsubscribe = service.subscribe((event) => received.push(event));

    service.emitConnectionEvent("blocked");
    service.emitConnectionEvent("versionchange");
    service.emitConnectionEvent("terminated");
    expect(received).toEqual(["blocked", "versionchange", "terminated"]);

    unsubscribe();
    service.emitConnectionEvent("blocked");
    expect(received).toHaveLength(3);
  });

  it("单个订阅者抛错不影响其余订阅者", () => {
    const service = new WebStorageHealthService();
    const received: string[] = [];
    service.subscribe(() => {
      throw new Error("bad listener");
    });
    service.subscribe((event) => received.push(event));
    service.emitConnectionEvent("blocked");
    expect(received).toEqual(["blocked"]);
  });
});
