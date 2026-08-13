/**
 * v4 → v5 迁移测试（R005 阶段 8 §8.2）：
 * - 新增 secrets store（SecretStore 的 Web 实现）；
 * - 旧版偏好记录 aiConfig.apiKey 迁移为 "ai.apiKey" secret，偏好记录
 *   改写为 aiEndpoint/aiModel 并删除 aiConfig 字段（apiKey 从普通偏好
 *   模型剥离）；
 * - 无旧配置（aiConfig null / 缺失）的记录为 no-op；
 * - v1 老库跳级 v5 叠加生效；迁移全部在 upgrade 事务内完成。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDB } from "idb";
import {
  DB_NAME,
  DB_VERSION,
  STORE_ATTACHMENTS,
  STORE_CONTENTS,
  STORE_PAGES,
  STORE_PAGE_TAGS,
  STORE_PREFERENCES,
  STORE_REVISIONS,
  STORE_SECRETS,
  STORE_TRASH,
  createV1Schema,
  getDB,
  resetDB,
} from "./db";
import { preferencesRepository } from "./repositories";
import { secretStore } from "./secretStore";
import { AI_API_KEY_SECRET } from "../../../application/services/SecretStore";

const NOW = 1_700_000_000_000;

/**
 * 以真实 v4 库写入旧结构 fixture。复刻 db.ts 的 v1–v4 分支的 schema 部分
 * （新增内容不得回改旧迁移函数，故此处手工复刻；数据回写与本次无关，省略）。
 */
async function writeV4Fixture(aiConfig: unknown) {
  const db = await openDB(DB_NAME, 4, {
    upgrade(db, _oldVersion, _newVersion, tx) {
      createV1Schema(db);
      const revisions = db.createObjectStore(STORE_REVISIONS, {
        keyPath: "id",
      });
      revisions.createIndex("pageId", "pageId");
      revisions.createIndex("pageId_createdAt", ["pageId", "createdAt"]);
      const attachments = db.createObjectStore(STORE_ATTACHMENTS, {
        keyPath: "id",
      });
      attachments.createIndex("pageId", "pageId");
      tx.objectStore(STORE_PAGES).createIndex("workspaceId_parentId", [
        "workspaceId",
        "parentId",
      ]);
      tx.objectStore(STORE_PAGES).createIndex("workspaceId_updatedAt", [
        "workspaceId",
        "updatedAt",
      ]);
      tx.objectStore(STORE_TRASH).createIndex("deletedAt", "deletedAt");
      tx.objectStore(STORE_CONTENTS).createIndex("workspaceId", "workspaceId");
      tx.objectStore(STORE_CONTENTS).createIndex("workspaceId_updatedAt", [
        "workspaceId",
        "updatedAt",
      ]);
      tx.objectStore(STORE_PAGE_TAGS).createIndex("workspaceId", "workspaceId");
    },
  });
  await db.put(STORE_PREFERENCES, {
    id: "preferences",
    theme: "dark",
    sidebarWidth: 300,
    aiConfig,
    lastRoute: null,
  });
  db.close();
}

beforeEach(async () => {
  await resetDB();
});

describe("v4 → v5 迁移（secrets store 与 apiKey 剥离）", () => {
  it("空库直接建 v5：secrets store 就位", async () => {
    const db = await getDB();
    expect(db.version).toBe(DB_VERSION);
    expect(db.objectStoreNames).toContain(STORE_SECRETS);
  });

  it("旧版 aiConfig.apiKey 迁入 secrets，偏好记录剥离 apiKey", async () => {
    await writeV4Fixture({
      endpoint: "https://api.example.com/v1",
      model: "test-model",
      apiKey: "sk-legacy",
    });

    const db = await getDB();
    expect(db.version).toBe(DB_VERSION);

    // 原始记录：aiConfig 删除、aiEndpoint/aiModel 写入。
    const raw = (await db.get(STORE_PREFERENCES, "preferences")) as Record<
      string,
      unknown
    >;
    expect("aiConfig" in raw).toBe(false);
    expect(raw.aiEndpoint).toBe("https://api.example.com/v1");
    expect(raw.aiModel).toBe("test-model");
    // 其余字段不动。
    expect(raw.theme).toBe("dark");
    expect(raw.sidebarWidth).toBe(300);

    // secret 可读；仓储读取为新形状且不含 apiKey。
    expect(await secretStore.get(AI_API_KEY_SECRET)).toBe("sk-legacy");
    const prefs = await preferencesRepository.get();
    expect(prefs.aiEndpoint).toBe("https://api.example.com/v1");
    expect(prefs.aiModel).toBe("test-model");
    expect("aiConfig" in prefs).toBe(false);
  });

  it("旧版 aiConfig 为 null：不产生 secret，记录正常剥离", async () => {
    await writeV4Fixture(null);
    const db = await getDB();
    expect(db.objectStoreNames).toContain(STORE_SECRETS);
    expect(await secretStore.get(AI_API_KEY_SECRET)).toBeNull();
    const raw = (await db.get(STORE_PREFERENCES, "preferences")) as Record<
      string,
      unknown
    >;
    expect("aiConfig" in raw).toBe(false);
    const prefs = await preferencesRepository.get();
    expect(prefs.aiEndpoint).toBeNull();
    expect(prefs.aiModel).toBeNull();
  });

  it("v1 老库跳级 v5：secrets store 与 apiKey 迁移叠加生效", async () => {
    const v1 = await openDB(DB_NAME, 1, {
      upgrade(db) {
        createV1Schema(db);
      },
    });
    await v1.put(STORE_PREFERENCES, {
      id: "preferences",
      theme: "light",
      sidebarWidth: 224,
      aiConfig: {
        endpoint: "https://old.example.com/v1",
        model: "old-model",
        apiKey: "sk-old",
      },
      lastRoute: null,
      createdAt: NOW,
    });
    v1.close();

    const db = await getDB();
    expect(db.version).toBe(DB_VERSION);
    expect(db.objectStoreNames).toContain(STORE_SECRETS);
    expect(await secretStore.get(AI_API_KEY_SECRET)).toBe("sk-old");
    const prefs = await preferencesRepository.get();
    expect(prefs.aiEndpoint).toBe("https://old.example.com/v1");
    expect(prefs.aiModel).toBe("old-model");
    expect("aiConfig" in prefs).toBe(false);
  });
});
