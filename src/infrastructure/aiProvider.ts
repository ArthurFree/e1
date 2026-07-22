import type { AIConfig } from "../domain/types";
import {
  AIHttpError,
  buildChatCompletionsUrl,
  buildChatRequestBody,
  mapAIError,
  type AIProvider,
} from "../domain/ai";

/**
 * aiProvider.ts —— AI provider 的 HTTP 实现。
 *
 * 基础设施层对 `domain/ai.ts` 中 `AIProvider` 接口的唯一实现：
 * 向用户在设置里配置的 OpenAI 兼容 endpoint 发起 chat/completions 请求。
 * URL 拼接、请求体构造、错误映射都在领域层（`domain/ai.ts`）完成，
 * 这里只负责「发请求 + 超时控制 + 取回文本」，因此替换成别的 provider
 * （如本地模型）时只需新增一个同接口实现。
 *
 * 隐私约束：API Key 只用于对该 endpoint 的 Authorization 请求头，
 * 不写日志、不做其他用途；未配置 AI 时上层不会调用本模块。
 */

const TIMEOUT_MS = 30_000;

/**
 * 创建一个 OpenAI 兼容的 AI provider。
 *
 * @param config 用户配置的 endpoint / model / apiKey（来自设置页，存于 IndexedDB）。
 * @returns `AIProvider`，其 `complete` 返回 AI 生成的纯文本。
 *
 * 边界与错误处理：
 * - 30 秒无响应则通过 AbortController 中止，避免 UI 长时间挂在等待态；
 * - HTTP 非 2xx、网络错误、超时统一经 `mapAIError` 映射为用户可读的中文文案后抛出；
 * - 返回体结构非法或内容为空时按「AI 返回内容为空」抛错，由上层提示重试。
 */
export function createOpenAICompatibleProvider(config: AIConfig): AIProvider {
  return {
    async complete(request) {
      // mode 缺省按 "ask" 处理，与领域层 buildChatRequestBody 的提示词分支保持一致。
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
        // 兼容 OpenAI 之外的兼容实现：content 缺失、非字符串或纯空白都视为无效响应。
        if (typeof content !== "string" || content.trim() === "") {
          throw new Error("AI 返回内容为空");
        }
        return content;
      } catch (err) {
        // 一切底层错误（HTTP 状态、网络、abort、空内容）统一翻译成用户可读文案。
        throw new Error(mapAIError(err));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
