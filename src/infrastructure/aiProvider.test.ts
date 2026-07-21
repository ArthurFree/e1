import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIConfig } from "../domain/types";
import { createOpenAICompatibleProvider } from "./aiProvider";

const config: AIConfig = {
  endpoint: "https://api.example.com/v1",
  model: "test-model",
  apiKey: "sk-secret",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createOpenAICompatibleProvider", () => {
  it("按配置发起 POST 请求并携带鉴权头", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "回答" } }] }),
    );
    const provider = createOpenAICompatibleProvider(config);
    await provider.complete({ prompt: "你好" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer sk-secret",
    });
    const body = JSON.parse(init.body as string) as {
      model: string;
      messages: { role: string; content: string }[];
      temperature: number;
    };
    expect(body.model).toBe("test-model");
    expect(body.temperature).toBe(0.7);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toContain("你好");
  });

  it("返回 choices[0].message.content", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "润色后的文字" } }] }),
    );
    const provider = createOpenAICompatibleProvider(config);
    const result = await provider.complete({
      prompt: "",
      selection: "原文",
      mode: "polish",
    });
    expect(result).toBe("润色后的文字");
  });

  it("HTTP 401 映射为权限错误", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 401));
    const provider = createOpenAICompatibleProvider(config);
    await expect(provider.complete({ prompt: "hi" })).rejects.toThrow(
      "API Key 无效或没有权限",
    );
  });

  it("HTTP 500 映射为服务不可用", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));
    const provider = createOpenAICompatibleProvider(config);
    await expect(provider.complete({ prompt: "hi" })).rejects.toThrow(
      "AI 服务暂时不可用（状态码 500）",
    );
  });

  it("网络失败（TypeError）映射为连接错误", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const provider = createOpenAICompatibleProvider(config);
    await expect(provider.complete({ prompt: "hi" })).rejects.toThrow(
      "无法连接到 AI 服务，请检查网络和 Endpoint",
    );
  });

  it("中止（AbortError，如超时触发）映射为超时错误", async () => {
    fetchMock.mockRejectedValue(new DOMException("Aborted", "AbortError"));
    const provider = createOpenAICompatibleProvider(config);
    await expect(provider.complete({ prompt: "hi" })).rejects.toThrow(
      "请求超时，请检查网络或服务地址",
    );
  });

  it("choices 为空时报错", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [] }));
    const provider = createOpenAICompatibleProvider(config);
    await expect(provider.complete({ prompt: "hi" })).rejects.toThrow(
      "AI 请求失败，请稍后再试",
    );
  });

  it("返回内容为空白时报错", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "   " } }] }),
    );
    const provider = createOpenAICompatibleProvider(config);
    await expect(provider.complete({ prompt: "hi" })).rejects.toThrow(
      "AI 请求失败，请稍后再试",
    );
  });

  it("endpoint 带尾斜杠时 URL 规范化", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    );
    const provider = createOpenAICompatibleProvider({
      ...config,
      endpoint: "https://api.example.com/v1/",
    });
    await provider.complete({ prompt: "hi" });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
  });
});
