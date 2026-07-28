import { describe, expect, it } from "vitest";
import {
  INTERVAL_REVISION_MS,
  revisionContentBytes,
  selectRevisionsToPrune,
  shouldCreateIntervalRevision,
} from "./revisions";

describe("shouldCreateIntervalRevision", () => {
  it("尚无自动版本时创建", () => {
    expect(shouldCreateIntervalRevision(null, Date.now())).toBe(true);
  });

  it("间隔不足 5 分钟不创建", () => {
    const now = 1_000_000_000_000;
    expect(
      shouldCreateIntervalRevision(now - INTERVAL_REVISION_MS + 1, now),
    ).toBe(false);
  });

  it("达到 5 分钟间隔创建", () => {
    const now = 1_000_000_000_000;
    expect(shouldCreateIntervalRevision(now - INTERVAL_REVISION_MS, now)).toBe(
      true,
    );
  });
});

describe("revisionContentBytes / selectRevisionsToPrune（R004 阶段 6 字节预算）", () => {
  it("字节数为 JSON 序列化的 UTF-8 大小", () => {
    const json = { type: "doc", content: [{ type: "text", text: "汉字" }] };
    expect(revisionContentBytes(json)).toBe(
      new Blob([JSON.stringify(json)]).size,
    );
    expect(revisionContentBytes(null)).toBe(new Blob(["null"]).size);
  });

  it("数量上限之外再按总字节裁剪，最旧的先删", () => {
    // 4 个版本（新→旧），各 100 字节；预算 250 → 保留最新 3 个中的前两个 + …
    const revisions = [
      { id: "r4", bytes: 100 },
      { id: "r3", bytes: 100 },
      { id: "r2", bytes: 100 },
      { id: "r1", bytes: 100 },
    ];
    // 数量上限 100（不起作用），字节预算 250：r4+r3=200 保留，r2 加入后 300 超预算。
    expect(
      selectRevisionsToPrune(revisions, 100, 250).map((r) => r.id),
    ).toEqual(["r2", "r1"]);
    // 数量上限 2、预算充足：与旧行为一致，只裁超额数量。
    expect(
      selectRevisionsToPrune(revisions, 2, Number.POSITIVE_INFINITY).map(
        (r) => r.id,
      ),
    ).toEqual(["r2", "r1"]);
  });

  it("最新版本始终保留，即使其自身超过预算", () => {
    const revisions = [
      { id: "big", bytes: 10_000 },
      { id: "old", bytes: 1 },
    ];
    expect(selectRevisionsToPrune(revisions, 100, 5).map((r) => r.id)).toEqual([
      "old",
    ]);
  });

  it("不超预算时不删除任何版本", () => {
    const revisions = [
      { id: "r2", bytes: 10 },
      { id: "r1", bytes: 10 },
    ];
    expect(selectRevisionsToPrune(revisions, 5, 100)).toEqual([]);
  });

  it("预算耗尽后删除全部更旧版本（确定性，不跳过大版本保留小版本）", () => {
    const revisions = [
      { id: "r5", bytes: 100 },
      { id: "r4", bytes: 400 }, // 加入后超预算
      { id: "r3", bytes: 10 }, // 即使本身很小也不保留
      { id: "r2", bytes: 10 },
    ];
    expect(
      selectRevisionsToPrune(revisions, 100, 200).map((r) => r.id),
    ).toEqual(["r4", "r3", "r2"]);
  });
});
