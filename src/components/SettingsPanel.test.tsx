import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppProvider, useApp } from "../state/AppState";
import { resetDB } from "../infrastructure/db";
import { preferencesRepository } from "../infrastructure/repositories";
import { SettingsPanel } from "./SettingsPanel";

/** 等 AppProvider 初始加载完成后再渲染面板，避免加载覆盖测试中的保存。 */
function ReadySettingsPanel() {
  const { ready } = useApp();
  return ready ? <SettingsPanel /> : null;
}

describe("SettingsPanel", () => {
  beforeEach(async () => {
    cleanup();
    await resetDB();
  });

  it("未配置时显示未配置状态", async () => {
    render(
      <AppProvider>
        <ReadySettingsPanel />
      </AppProvider>,
    );
    expect(await screen.findByText("AI 未配置")).toBeInTheDocument();
  });

  it("非法 Endpoint 保存时显示校验错误", async () => {
    render(
      <AppProvider>
        <ReadySettingsPanel />
      </AppProvider>,
    );
    fireEvent.change(await screen.findByLabelText("Endpoint"), {
      target: { value: "not-a-url" },
    });
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "gpt-4o-mini" } });
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByText("保存"));
    expect(
      await screen.findByText("Endpoint 必须是合法的 http(s) 地址"),
    ).toBeInTheDocument();
    const prefs = await preferencesRepository.get();
    expect(prefs.aiConfig).toBeNull();
  });

  it("合法配置保存后写入 IndexedDB 并可清除", async () => {
    render(
      <AppProvider>
        <ReadySettingsPanel />
      </AppProvider>,
    );
    fireEvent.change(await screen.findByLabelText("Endpoint"), {
      target: { value: "https://api.openai.com/v1" },
    });
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "gpt-4o-mini" } });
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "sk-test" } });
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
