/**
 * SaveStateIndicator 失败文案测试（R004 阶段 6）：
 * 配额耗尽与普通写入失败展示不同提示。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SaveStateIndicator } from "./SaveStateIndicator";

beforeEach(() => cleanup());

describe("SaveStateIndicator 错误文案", () => {
  it("配额耗尽显示「本地存储空间不足」", () => {
    render(
      <SaveStateIndicator
        state={{ status: "error", savedAt: null, errorKind: "quota" }}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("本地存储空间不足");
  });

  it("普通失败显示「保存失败」", () => {
    render(
      <SaveStateIndicator
        state={{ status: "error", savedAt: null, errorKind: "generic" }}
        onRetry={vi.fn()}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("保存失败");
    expect(alert.textContent).not.toContain("空间不足");
  });

  it("已保存状态显示时间", () => {
    render(
      <SaveStateIndicator
        state={{ status: "saved", savedAt: Date.now(), errorKind: null }}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("已保存");
  });
});
