import type { AIConfig } from "./types";

/**
 * AI 领域逻辑：配置校验、请求构造与错误映射。
 * 纯函数，无 DOM / fetch 依赖，provider 实现在基础设施层。
 */

export type AIMode = "ask" | "polish" | "rewrite" | "summarize";

export interface AIRequest {
  prompt: string;
  /** 当前选区文字（润色、改写、总结时使用）。 */
  selection?: string;
  /** 文档上下文（正文快照片段）。 */
  documentContext?: string;
  /** 请求模式，缺省为 ask。 */
  mode?: AIMode;
}

export interface AIProvider {
  complete(request: AIRequest): Promise<string>;
}

/** HTTP 状态码错误，供错误映射识别。 */
export class AIHttpError extends Error {
  constructor(public status: number) {
    super(`AI 服务返回错误（状态码 ${status}）`);
    this.name = "AIHttpError";
  }
}

/** 校验 AI 配置，返回具体中文错误消息；合法时返回 null。 */
export function validateAIConfig(config: AIConfig): string | null {
  let url: URL;
  try {
    url = new URL(config.endpoint);
  } catch {
    return "Endpoint 必须是合法的 http(s) 地址";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Endpoint 必须是合法的 http(s) 地址";
  }
  if (config.model.trim() === "") {
    return "模型名称不能为空";
  }
  if (config.apiKey.trim() === "") {
    return "API Key 不能为空";
  }
  return null;
}

/** 配置存在且通过校验即视为已配置。 */
export function isAIConfigured(config: AIConfig | null): boolean {
  return config !== null && validateAIConfig(config) === null;
}

/** 把用户填写的 base endpoint 规范化为 chat/completions 完整地址。 */
export function buildChatCompletionsUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) return base;
  return `${base}/chat/completions`;
}

/** 按模式构造中文 system / user prompt。 */
export function buildPrompt(
  mode: AIMode,
  request: AIRequest,
): { system: string; user: string } {
  const systemByMode: Record<AIMode, string> = {
    ask: "你是一个笔记应用内的 AI 助手。请根据用户的问题作答；如果提供了选区或文档上下文，优先结合它们回答。请使用简体中文，以 Markdown 格式返回，只返回回答内容本身，不要附加解释。",
    polish: "你是一个文字润色助手。请润色用户提供的文字，保持原意不变，只改进表达与流畅度。请使用简体中文，以 Markdown 格式返回，只返回润色后的内容本身，不要附加解释。",
    rewrite: "你是一个文字改写助手。请改写用户提供的文字，保持核心信息不变，可以调整结构与措辞。请使用简体中文，以 Markdown 格式返回，只返回改写后的内容本身，不要附加解释。",
    summarize: "你是一个内容总结助手。请总结用户提供的选区或文档内容，提炼要点。请使用简体中文，以 Markdown 格式返回，只返回总结内容本身，不要附加解释。",
  };

  const parts: string[] = [];
  if (request.prompt.trim() !== "") {
    parts.push(`问题：${request.prompt}`);
  }
  if (request.selection && request.selection.trim() !== "") {
    parts.push(`选区内容：\n${request.selection}`);
  }
  if (request.documentContext && request.documentContext.trim() !== "") {
    parts.push(`文档上下文：\n${request.documentContext}`);
  }

  return { system: systemByMode[mode], user: parts.join("\n\n") };
}

/** 构造 OpenAI 兼容 chat/completions 请求体。 */
export function buildChatRequestBody(
  config: AIConfig,
  request: AIRequest & { mode: AIMode },
): {
  model: string;
  messages: { role: "system" | "user"; content: string }[];
  temperature: number;
} {
  const { system, user } = buildPrompt(request.mode, request);
  return {
    model: config.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.7,
  };
}

/** 把各类异常映射为面向用户的中文错误消息。 */
export function mapAIError(error: unknown): string {
  if (error instanceof AIHttpError) {
    const { status } = error;
    if (status === 401 || status === 403) return "API Key 无效或没有权限";
    if (status === 404) return "服务地址或模型不存在";
    if (status === 429) return "请求过于频繁，请稍后再试";
    if (status >= 500) return `AI 服务暂时不可用（状态码 ${status}）`;
    return `AI 服务返回错误（状态码 ${status}）`;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return "请求超时，请检查网络或服务地址";
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "请求超时，请检查网络或服务地址";
  }
  if (error instanceof TypeError) {
    return "无法连接到 AI 服务，请检查网络和 Endpoint";
  }
  return "AI 请求失败，请稍后再试";
}
