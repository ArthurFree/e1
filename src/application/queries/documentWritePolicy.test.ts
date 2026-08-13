/**
 * DocumentWritePolicy 判定与会话授权（R006-C4 FR-01/03/04）。
 */
import { describe, expect, it } from "vitest";
import {
  accessFromWritePolicy,
  createEmptyWriteSessionState,
  DEFAULT_WRITE_POLICY,
  isTransientVaultId,
  resolveWritePolicy,
} from "./documentWritePolicy";

describe("resolveWritePolicy（FR-03）", () => {
  it("已初始化 + 无损 + 有稳定 ID → read-write", () => {
    expect(
      resolveWritePolicy({
        transient: false,
        lossy: false,
        stableNoteId: "01JABC",
      }),
    ).toEqual(DEFAULT_WRITE_POLICY);
  });

  it("transient Vault → read-only / transient-vault（最高优先级）", () => {
    expect(
      resolveWritePolicy({
        transient: true,
        lossy: true,
        stableNoteId: null,
      }),
    ).toEqual({ mode: "read-only", reason: "transient-vault" });
  });

  it("lossy → confirmation-required / lossy-source（优先于 identity-adoption）", () => {
    expect(
      resolveWritePolicy({
        transient: false,
        lossy: true,
        stableNoteId: null,
      }),
    ).toEqual({ mode: "confirmation-required", reason: "lossy-source" });
  });

  it("无损但无稳定 ID → confirmation-required / identity-adoption", () => {
    expect(
      resolveWritePolicy({
        transient: false,
        lossy: false,
        stableNoteId: null,
      }),
    ).toEqual({ mode: "confirmation-required", reason: "identity-adoption" });
  });
});

describe("accessFromWritePolicy", () => {
  it("read-write → editable；其余默认 read-only", () => {
    expect(accessFromWritePolicy({ mode: "read-write" })).toBe("editable");
    expect(
      accessFromWritePolicy({
        mode: "confirmation-required",
        reason: "lossy-source",
      }),
    ).toBe("read-only");
    expect(
      accessFromWritePolicy({
        mode: "confirmation-required",
        reason: "identity-adoption",
      }),
    ).toBe("read-only");
    expect(
      accessFromWritePolicy({
        mode: "read-only",
        reason: "transient-vault",
      }),
    ).toBe("read-only");
  });
});

describe("会话授权与 vaultId 辅助", () => {
  it("createEmptyWriteSessionState 全 false", () => {
    expect(createEmptyWriteSessionState()).toEqual({
      sourceLossyApproved: false,
      outputLossyApproved: false,
      identityAdoptionApproved: false,
    });
  });

  it("isTransientVaultId 识别 transient: 前缀", () => {
    expect(isTransientVaultId("transient:abc")).toBe(true);
    expect(isTransientVaultId("v1")).toBe(false);
  });
});
