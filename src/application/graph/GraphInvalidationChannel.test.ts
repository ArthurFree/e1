import { describe, expect, it, vi } from "vitest";
import { GraphInvalidationChannel } from "./GraphInvalidationChannel";

describe("GraphInvalidationChannel", () => {
  it("publish 递增 generation 并通知订阅者", () => {
    const channel = new GraphInvalidationChannel();
    const listener = vi.fn();
    const unsubscribe = channel.subscribe(listener);
    expect(channel.getGeneration()).toBe(0);
    channel.publish();
    expect(channel.getGeneration()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    channel.publish();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(channel.getGeneration()).toBe(2);
  });
});
