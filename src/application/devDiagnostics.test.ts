/**
 * devDiagnostics 测试（R003 阶段 8）：
 * - 禁用时零输出；启用时输出格式正确；
 * - 默认状态在 vitest 下为禁用（生产路径经 import.meta.env 判定）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  increment,
  isDevDiagnosticsEnabled,
  setDevDiagnosticsEnabled,
  trackTiming,
} from "./devDiagnostics";

describe("devDiagnostics", () => {
  beforeEach(() => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
  });

  afterEach(() => {
    setDevDiagnosticsEnabled(false);
    vi.restoreAllMocks();
  });

  it("vitest 环境默认禁用", () => {
    expect(isDevDiagnosticsEnabled()).toBe(false);
  });

  it("禁用时零输出", () => {
    setDevDiagnosticsEnabled(false);
    trackTiming("workspace-load", 12.4);
    increment("corrupted-content");
    expect(console.debug).not.toHaveBeenCalled();
  });

  it("启用时 trackTiming 输出毫秒指标", () => {
    setDevDiagnosticsEnabled(true);
    trackTiming("workspace-load", 12.4);
    expect(console.debug).toHaveBeenCalledWith(
      "[dev-diag] workspace-load: 12ms",
    );
  });

  it("启用时 increment 输出计数与标识", () => {
    setDevDiagnosticsEnabled(true);
    increment("corrupted-content");
    increment("db-migration", "v2→v3");
    expect(console.debug).toHaveBeenCalledWith("[dev-diag] corrupted-content");
    expect(console.debug).toHaveBeenCalledWith(
      "[dev-diag] db-migration: v2→v3",
    );
  });
});
