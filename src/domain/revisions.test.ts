import { describe, expect, it } from "vitest";
import {
  INTERVAL_REVISION_MS,
  shouldCreateIntervalRevision,
} from "./revisions";

describe("shouldCreateIntervalRevision", () => {
  it("尚无自动版本时创建", () => {
    expect(shouldCreateIntervalRevision(null, Date.now())).toBe(true);
  });

  it("间隔不足 5 分钟不创建", () => {
    const now = 1_000_000_000_000;
    expect(shouldCreateIntervalRevision(now - INTERVAL_REVISION_MS + 1, now)).toBe(false);
  });

  it("达到 5 分钟间隔创建", () => {
    const now = 1_000_000_000_000;
    expect(shouldCreateIntervalRevision(now - INTERVAL_REVISION_MS, now)).toBe(true);
  });
});
