import { describe, expect, it } from "vitest";
import type { AIConfig } from "./types";
import {
  AIHttpError,
  buildChatCompletionsUrl,
  buildChatRequestBody,
  buildPrompt,
  isAIConfigured,
  mapAIError,
  validateAIConfig,
} from "./ai";

const validConfig: AIConfig = {
  endpoint: "https://api.example.com/v1",
  model: "test-model",
  apiKey: "sk-test",
};

describe("validateAIConfig", () => {
  it("非法 URL 返回错误", () => {
    expect(
      validateAIConfig({ ...validConfig, endpoint: "not-a-url" }),
    ).toBe("Endpoint 必须是合法的 http(s) 地址");
  });

  it("非 http(s) 协议返回错误", () => {
    expect(
      validateAIConfig({ ...validConfig, endpoint: "ftp://api.example.com" }),
    ).toBe("Endpoint 必须是合法的 http(s) 地址");
  });

  it("模型名称为空白返回错误", () => {
    expect(validateAIConfig({ ...validConfig, model: "   " })).toBe(
      "模型名称不能为空",
    );
  });

  it("API Key 为空白返回错误", () => {
    expect(validateAIConfig({ ...validConfig, apiKey: "" })).toBe(
      "API Key 不能为空",
    );
  });

  it("合法配置返回 null", () => {
    expect(validateAIConfig(validConfig)).toBeNull();
    expect(
      validateAIConfig({ ...validConfig, endpoint: "http://localhost:11434/v1" }),
    ).toBeNull();
  });
});

describe("isAIConfigured", () => {
  it("null 或非法配置返回 false", () => {
    expect(isAIConfigured(null)).toBe(false);
    expect(isAIConfigured({ ...validConfig, apiKey: "" })).toBe(false);
  });

  it("合法配置返回 true", () => {
    expect(isAIConfigured(validConfig)).toBe(true);
  });
});

describe("buildChatCompletionsUrl", () => {
  it("去掉尾部斜杠后拼接路径", () => {
    expect(buildChatCompletionsUrl("https://api.example.com/v1/")).toBe(
      "https://api.example.com/v1/chat/completions",
    );
  });

  it("已是完整路径时原样返回", () => {
    expect(
      buildChatCompletionsUrl("https://api.example.com/v1/chat/completions"),
    ).toBe("https://api.example.com/v1/chat/completions");
  });

  it("base 地址拼接路径", () => {
    expect(buildChatCompletionsUrl("https://api.example.com")).toBe(
      "https://api.example.com/chat/completions",
    );
  });
});

describe("buildPrompt", () => {
  it("ask 模式包含问题", () => {
    const { system, user } = buildPrompt("ask", { prompt: "什么是索引？" });
    expect(system).toContain("简体中文");
    expect(system).toContain("Markdown");
    expect(user).toContain("问题：什么是索引？");
    expect(user).not.toContain("选区内容");
    expect(user).not.toContain("文档上下文");
  });

  it("polish 模式包含选区", () => {
    const { system, user } = buildPrompt("polish", {
      prompt: "",
      selection: "一段需要润色的文字",
    });
    expect(system).toContain("润色");
    expect(user).toContain("选区内容：\n一段需要润色的文字");
  });

  it("rewrite 模式包含选区", () => {
    const { system, user } = buildPrompt("rewrite", {
      prompt: "",
      selection: "需要改写的文字",
    });
    expect(system).toContain("改写");
    expect(user).toContain("选区内容：\n需要改写的文字");
  });

  it("summarize 模式可只带文档上下文", () => {
    const { system, user } = buildPrompt("summarize", {
      prompt: "",
      documentContext: "整篇文档的快照",
    });
    expect(system).toContain("总结");
    expect(user).toContain("文档上下文：\n整篇文档的快照");
    expect(user).not.toContain("选区内容");
  });

  it("多字段同时存在时全部拼装", () => {
    const { user } = buildPrompt("ask", {
      prompt: "这段话什么意思？",
      selection: "选中的话",
      documentContext: "上下文",
    });
    expect(user).toBe("问题：这段话什么意思？\n\n选区内容：\n选中的话\n\n文档上下文：\n上下文");
  });
});

describe("buildChatRequestBody", () => {
  it("返回 OpenAI chat/completions 结构", () => {
    const body = buildChatRequestBody(validConfig, {
      mode: "polish",
      prompt: "",
      selection: "原文",
    });
    expect(body.model).toBe("test-model");
    expect(body.temperature).toBe(0.7);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toContain("原文");
  });
});

describe("mapAIError", () => {
  it("401/403 映射为权限错误", () => {
    expect(mapAIError(new AIHttpError(401))).toBe("API Key 无效或没有权限");
    expect(mapAIError(new AIHttpError(403))).toBe("API Key 无效或没有权限");
  });

  it("404 映射为地址或模型不存在", () => {
    expect(mapAIError(new AIHttpError(404))).toBe("服务地址或模型不存在");
  });

  it("429 映射为频率限制", () => {
    expect(mapAIError(new AIHttpError(429))).toBe("请求过于频繁，请稍后再试");
  });

  it("5xx 映射为服务不可用并带状态码", () => {
    expect(mapAIError(new AIHttpError(500))).toBe("AI 服务暂时不可用（状态码 500）");
    expect(mapAIError(new AIHttpError(503))).toBe("AI 服务暂时不可用（状态码 503）");
  });

  it("其他状态码映射为通用 HTTP 错误", () => {
    expect(mapAIError(new AIHttpError(400))).toBe("AI 服务返回错误（状态码 400）");
  });

  it("AbortError 映射为超时", () => {
    expect(mapAIError(new DOMException("Aborted", "AbortError"))).toBe(
      "请求超时，请检查网络或服务地址",
    );
  });

  it("TypeError 映射为网络连接失败", () => {
    expect(mapAIError(new TypeError("fetch failed"))).toBe(
      "无法连接到 AI 服务，请检查网络和 Endpoint",
    );
  });

  it("未知错误映射为通用失败", () => {
    expect(mapAIError(new Error("unknown"))).toBe("AI 请求失败，请稍后再试");
    expect(mapAIError("字符串错误")).toBe("AI 请求失败，请稍后再试");
  });
});
