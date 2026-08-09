/**
 * AIConfigService 测试（R005 阶段 8 §8.2）：
 * endpoint/model 取偏好（PreferencesService 串行队列）、apiKey 取
 * SecretStore 的组装语义；save/clear 的双通道写入；缺失任一部件时
 * get 返回 null（调用方按未配置处理，不发起请求）。
 */
import { describe, expect, it } from "vitest";
import { AIConfigService } from "./AIConfigService";
import { PreferencesService } from "./PreferencesService";
import { AI_API_KEY_SECRET } from "./SecretStore";
import { InMemorySecretStore } from "../../infrastructure/memory/secretStore";
import {
  createInMemoryRepositories,
  createMemoryStore,
} from "../../infrastructure/memory/repositories";

const CONFIG = {
  endpoint: "https://api.example.com/v1",
  model: "test-model",
  apiKey: "sk-test",
};

function makeService() {
  const repos = createInMemoryRepositories(createMemoryStore());
  const preferencesService = new PreferencesService({
    preferences: repos.preferences,
  });
  const secrets = new InMemorySecretStore();
  const service = new AIConfigService({
    preferences: preferencesService,
    secrets,
  });
  return { service, preferencesService, secrets };
}

describe("AIConfigService", () => {
  it("未配置时 get 返回 null", async () => {
    const { service } = makeService();
    expect(await service.get()).toBeNull();
  });

  it("save：endpoint/model 入偏好、apiKey 入 SecretStore，get 组装完整配置", async () => {
    const { service, preferencesService, secrets } = makeService();
    await service.save(CONFIG);

    const prefs = await preferencesService.get();
    expect(prefs.aiEndpoint).toBe(CONFIG.endpoint);
    expect(prefs.aiModel).toBe(CONFIG.model);
    // apiKey 不进入偏好记录。
    expect("aiConfig" in prefs).toBe(false);
    expect(await secrets.get(AI_API_KEY_SECRET)).toBe(CONFIG.apiKey);
    expect(await service.get()).toEqual(CONFIG);
  });

  it("secret 缺失（如被单独清除）时 get 返回 null", async () => {
    const { service, secrets } = makeService();
    await service.save(CONFIG);
    await secrets.remove(AI_API_KEY_SECRET);
    expect(await service.get()).toBeNull();
  });

  it("clear：secret 移除且偏好中的 endpoint/model 清空", async () => {
    const { service, preferencesService, secrets } = makeService();
    await service.save(CONFIG);
    await service.clear();

    expect(await secrets.get(AI_API_KEY_SECRET)).toBeNull();
    const prefs = await preferencesService.get();
    expect(prefs.aiEndpoint).toBeNull();
    expect(prefs.aiModel).toBeNull();
    expect(await service.get()).toBeNull();
  });

  it("save 覆盖旧配置", async () => {
    const { service } = makeService();
    await service.save(CONFIG);
    await service.save({ ...CONFIG, model: "other-model", apiKey: "sk-2" });
    expect(await service.get()).toEqual({
      ...CONFIG,
      model: "other-model",
      apiKey: "sk-2",
    });
  });
});
