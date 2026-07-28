/**
 * SyncChannelService 单元测试（R004 阶段 7 §7.2）：
 * 发送信封（来源 tabId）、接收过滤（回声抑制/非法数据）、
 * 退订、无 BroadcastChannel 环境降级 no-op。
 */
import { describe, expect, it, vi } from "vitest";
import type { AppSyncEvent } from "../../domain/sync";
import {
  SyncChannelService,
  type BroadcastChannelLike,
} from "./SyncChannelService";

function makeMockChannel() {
  const posted: unknown[] = [];
  const channel: BroadcastChannelLike = {
    onmessage: null,
    postMessage: (message) => {
      posted.push(message);
    },
    close: vi.fn(),
  };
  /** 模拟收到一条来自其他标签页的消息。 */
  const emit = (data: unknown) => {
    channel.onmessage?.({ data });
  };
  return { channel, posted, emit };
}

const EVENT: AppSyncEvent = { type: "preferences-changed" };

describe("SyncChannelService", () => {
  it("post 广播带 tabId 的信封", () => {
    const { channel, posted } = makeMockChannel();
    const service = new SyncChannelService(channel, "tab-A");
    service.post(EVENT);
    expect(posted).toEqual([{ source: "tab-A", event: EVENT }]);
  });

  it("subscribe 收到其他标签页的事件", () => {
    const { channel, emit } = makeMockChannel();
    const service = new SyncChannelService(channel, "tab-A");
    const received: AppSyncEvent[] = [];
    service.subscribe((event) => received.push(event));
    emit({ source: "tab-B", event: EVENT });
    expect(received).toEqual([EVENT]);
  });

  it("回声抑制：忽略自己发出的事件与非法数据", () => {
    const { channel, emit } = makeMockChannel();
    const service = new SyncChannelService(channel, "tab-A");
    const received: AppSyncEvent[] = [];
    service.subscribe((event) => received.push(event));
    emit({ source: "tab-A", event: EVENT });
    emit(null);
    emit({ source: "tab-B" });
    emit({ source: "tab-B", event: { type: "unknown-event" } });
    emit("garbage");
    expect(received).toEqual([]);
  });

  it("多个订阅者共享频道，互不覆盖", () => {
    const { channel, emit } = makeMockChannel();
    const service = new SyncChannelService(channel, "tab-A");
    const a: AppSyncEvent[] = [];
    const b: AppSyncEvent[] = [];
    service.subscribe((event) => a.push(event));
    service.subscribe((event) => b.push(event));
    emit({ source: "tab-B", event: EVENT });
    expect(a).toEqual([EVENT]);
    expect(b).toEqual([EVENT]);
  });

  it("退订后不再接收", () => {
    const { channel, emit } = makeMockChannel();
    const service = new SyncChannelService(channel, "tab-A");
    const received: AppSyncEvent[] = [];
    const unsubscribe = service.subscribe((event) => received.push(event));
    emit({ source: "tab-B", event: EVENT });
    unsubscribe();
    emit({ source: "tab-B", event: EVENT });
    expect(received).toEqual([EVENT]);
  });

  it("无 BroadcastChannel（null 频道）：post/subscribe 为 no-op", () => {
    const service = new SyncChannelService(null, "tab-A");
    expect(() => service.post(EVENT)).not.toThrow();
    const unsubscribe = service.subscribe(() => {
      throw new Error("不应被调用");
    });
    expect(() => unsubscribe()).not.toThrow();
    expect(() => service.close()).not.toThrow();
  });

  it("postMessage 抛错不影响本地动作", () => {
    const { channel } = makeMockChannel();
    channel.postMessage = () => {
      throw new Error("频道已关闭");
    };
    const service = new SyncChannelService(channel, "tab-A");
    expect(() => service.post(EVENT)).not.toThrow();
  });
});
