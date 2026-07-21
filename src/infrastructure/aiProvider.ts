import type { AIConfig } from "../domain/types";
import {
  AIHttpError,
  buildChatCompletionsUrl,
  buildChatRequestBody,
  mapAIError,
  type AIProvider,
} from "../domain/ai";

/**
 * OpenAI 兼容的 AI provider：向用户配置的 endpoint 发起 chat/completions 请求。
 * API Key 只用于对该 endpoint 的 Authorization 请求头，不写日志、不做其他用途。
 */

const TIMEOUT_MS = 30_000;

export function createOpenAICompatibleProvider(config: AIConfig): AIProvider {
  return {
    async complete(request) {
      const mode = request.mode ?? "ask";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(buildChatCompletionsUrl(config.endpoint), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(buildChatRequestBody(config, { ...request, mode })),
          signal: controller.signal,
        });
        if (!res.ok) throw new AIHttpError(res.status);
        const data = (await res.json()) as {
          choices?: { message?: { content?: unknown } }[];
        };
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== "string" || content.trim() === "") {
          throw new Error("AI 返回内容为空");
        }
        return content;
      } catch (err) {
        throw new Error(mapAIError(err));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
