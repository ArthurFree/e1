/**
 * AI 配置组装服务（R005 阶段 8 §8.2）：createAIProvider 调用方的统一
 * 取数通道——endpoint/model 来自偏好（PreferencesService 串行队列），
 * apiKey 来自 SecretStore，避免每个调用方重复拼装。
 *
 * - get：任一部分缺失（未配置 / secret 被清除）返回 null，调用方按
 *   「未配置不发起任何外部请求」处理；
 * - save：先写 secret 再写偏好——secret 失败则偏好不动；偏好写失败时
 *   残留 secret 无害（settings 缺失时 get 仍返回 null）；
 * - clear：移除 secret 并清空偏好中的 endpoint/model；
 * - 偏好写入走 PreferencesService，落盘后由装配根广播 preferences-changed
 *   （跨标签页同步语义不变）；secret 变更不广播——其他标签页在下次
 *   get 时读到最新值（最小实现，R005 §8.2）。
 */
import type { AIConfig, Preferences } from "../../domain/types";
import { getAISettings } from "../../domain/ai";
import type { PreferencesService } from "./PreferencesService";
import { AI_API_KEY_SECRET, type SecretStore } from "./SecretStore";

export interface AIConfigServiceDeps {
  preferences: PreferencesService;
  secrets: SecretStore;
}

export class AIConfigService {
  constructor(private readonly deps: AIConfigServiceDeps) {}

  /** 组装完整 AI 配置；endpoint/model/apiKey 任一缺失返回 null。 */
  async get(): Promise<AIConfig | null> {
    const settings = getAISettings(await this.deps.preferences.get());
    if (!settings) return null;
    const apiKey = await this.deps.secrets.get(AI_API_KEY_SECRET);
    if (!apiKey) return null;
    return { ...settings, apiKey };
  }

  /** 保存 AI 配置：apiKey 入 SecretStore，endpoint/model 入偏好。 */
  async save(config: AIConfig): Promise<Preferences> {
    await this.deps.secrets.set(AI_API_KEY_SECRET, config.apiKey);
    return this.deps.preferences.update({
      aiEndpoint: config.endpoint,
      aiModel: config.model,
    });
  }

  /** 清除 AI 配置：移除 secret 并清空偏好中的 endpoint/model。 */
  async clear(): Promise<Preferences> {
    await this.deps.secrets.remove(AI_API_KEY_SECRET);
    return this.deps.preferences.update({ aiEndpoint: null, aiModel: null });
  }
}
