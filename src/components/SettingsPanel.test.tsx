import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useApp } from "../state/AppState";
import { TestApp } from "../test/TestApp";
import { resetDB } from "../infrastructure/db";
import { preferencesRepository } from "../infrastructure/repositories";
import { SettingsPanel } from "./SettingsPanel";

/** 等 AppProvider 初始加载完成后再渲染面板，避免加载覆盖测试中的保存。 */
function ReadySettingsPanel() {
  const { ready } = useApp();
  return ready ? <SettingsPanel /> : null;
}

/** 临时替换 navigator.storage（jsdom 默认无此属性）。 */
function stubStorageEstimate(estimate: (() => Promise<unknown>) | undefined) {
  const original = Object.getOwnPropertyDescriptor(
    Navigator.prototype,
    "storage",
  );
  Object.defineProperty(Navigator.prototype, "storage", {
    configurable: true,
    get: () => (estimate ? { estimate } : undefined),
  });
  return () => {
    if (original) {
      Object.defineProperty(Navigator.prototype, "storage", original);
    } else {
      delete (Navigator.prototype as unknown as Record<string, unknown>)
        .storage;
    }
  };
}

describe("SettingsPanel", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
  });

  it("未配置时显示未配置状态", async () => {
    render(
      <TestApp>
        <ReadySettingsPanel />
      </TestApp>,
    );
    expect(await screen.findByText("AI 未配置")).toBeInTheDocument();
  });

  it("非法 Endpoint 保存时显示校验错误", async () => {
    render(
      <TestApp>
        <ReadySettingsPanel />
      </TestApp>,
    );
    fireEvent.change(await screen.findByLabelText("Endpoint"), {
      target: { value: "not-a-url" },
    });
    fireEvent.change(screen.getByLabelText("模型"), {
      target: { value: "gpt-4o-mini" },
    });
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "sk-test" },
    });
    fireEvent.click(screen.getByText("保存"));
    expect(
      await screen.findByText("Endpoint 必须是合法的 http(s) 地址"),
    ).toBeInTheDocument();
    const prefs = await preferencesRepository.get();
    expect(prefs.aiConfig).toBeNull();
  });

  it("合法配置保存后写入 IndexedDB 并可清除", async () => {
    render(
      <TestApp>
        <ReadySettingsPanel />
      </TestApp>,
    );
    fireEvent.change(await screen.findByLabelText("Endpoint"), {
      target: { value: "https://api.openai.com/v1" },
    });
    fireEvent.change(screen.getByLabelText("模型"), {
      target: { value: "gpt-4o-mini" },
    });
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "sk-test" },
    });
    fireEvent.click(screen.getByText("保存"));

    expect(await screen.findByText("已保存。")).toBeInTheDocument();
    expect(await screen.findByText("AI 已配置")).toBeInTheDocument();
    const prefs = await preferencesRepository.get();
    expect(prefs.aiConfig).toEqual({
      endpoint: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKey: "sk-test",
    });

    fireEvent.click(screen.getByText("清除配置"));
    expect(await screen.findByText("AI 未配置")).toBeInTheDocument();
    expect((await preferencesRepository.get()).aiConfig).toBeNull();
  });
});

describe("SettingsPanel 本地存储区（R004 阶段 6）", () => {
  let restore: (() => void) | null = null;
  beforeEach(async () => {
    cleanup();
    await resetDB();
  });
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("浏览器不支持 Storage API 时显示降级文案", async () => {
    restore = stubStorageEstimate(undefined);
    render(
      <TestApp>
        <ReadySettingsPanel />
      </TestApp>,
    );
    expect(
      await screen.findByText("当前浏览器不支持存储用量查询。"),
    ).toBeInTheDocument();
  });

  it("显示已用/配额与占比，低于阈值无警告", async () => {
    restore = stubStorageEstimate(() =>
      Promise.resolve({ usage: 20 * 1024 * 1024, quota: 100 * 1024 * 1024 }),
    );
    render(
      <TestApp>
        <ReadySettingsPanel />
      </TestApp>,
    );
    expect(
      await screen.findByText(/已使用 20\.0 MB \/ 100\.0 MB（20%）/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("用量达到 80% 阈值时显示空间不足警告", async () => {
    restore = stubStorageEstimate(() =>
      Promise.resolve({ usage: 85 * 1024 * 1024, quota: 100 * 1024 * 1024 }),
    );
    render(
      <TestApp>
        <ReadySettingsPanel />
      </TestApp>,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("本地存储空间不足");
  });
});
