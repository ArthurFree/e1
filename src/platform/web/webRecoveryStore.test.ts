/**
 * WebRecoveryStore 测试（R005 阶段 8 §8.1）：契约套件 + Web 专属断言——
 * localStorage key 格式与 R003 起的存量数据兼容、写入失败降级仅告警。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { describeRecoveryStoreContract } from "../../test/recoveryStoreContract";
import { WebRecoveryStore } from "./webRecoveryStore";

describeRecoveryStoreContract("Web localStorage", () => {
  localStorage.clear();
  return new WebRecoveryStore();
});

describe("WebRecoveryStore（Web 专属）", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("key 格式与存量恢复缓冲兼容（pending-document-recovery:<pageId>）", async () => {
    const store = new WebRecoveryStore();
    await store.write({
      pageId: "p1",
      contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      generation: 1,
      timestamp: 1000,
    });
    const raw = localStorage.getItem("pending-document-recovery:p1");
    expect(raw).not.toBeNull();
    // 存量数据（R003 起模块函数写入的 JSON）可直接读出。
    expect((JSON.parse(raw!) as { pageId: string }).pageId).toBe("p1");
  });

  it("localStorage 不可用/超限时仅告警，不抛出", async () => {
    const store = new WebRecoveryStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceeded");
      });
    await expect(
      store.write({
        pageId: "p1",
        contentJson: { type: "doc" },
        generation: 1,
        timestamp: 1,
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    setItem.mockRestore();
    warn.mockRestore();
  });

  it("read 到无法解析的原始数据时按损坏处理：删除并返回 null", async () => {
    localStorage.setItem("pending-document-recovery:p1", "{not-json");
    const store = new WebRecoveryStore();
    expect(await store.read("p1")).toBeNull();
    expect(localStorage.getItem("pending-document-recovery:p1")).toBeNull();
  });
});
