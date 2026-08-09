/**
 * SecretStore 的 Web（IndexedDB）实现（R005 阶段 8 §8.2）：
 * 机密值（当前仅 AI API Key，命名 "ai.apiKey"）存独立 secrets object
 * store（DB v5），与普通偏好记录分离。只存本机，不进入日志、同步或
 * 上报（AGENTS.md 安全约定）。
 *
 * 放在 infrastructure 而非 platform/web：实现依赖 db.ts 的连接管理
 * （getDB），与既有仓储同层；platform/web → infrastructure 的 import
 * 方向保持不变（反向会造成循环依赖）。
 */
import type { SecretStore } from "../application/services/SecretStore";
import { getDB, STORE_SECRETS } from "./db";

interface SecretRecord {
  name: string;
  value: string;
}

export const secretStore: SecretStore = {
  async get(name) {
    const db = await getDB();
    const record = (await db.get(STORE_SECRETS, name)) as
      SecretRecord | undefined;
    // 损坏记录（value 非字符串）按缺失处理，不抛错阻断主流程。
    return record && typeof record.value === "string" ? record.value : null;
  },

  async set(name, value) {
    const db = await getDB();
    await db.put(STORE_SECRETS, { name, value });
  },

  async remove(name) {
    const db = await getDB();
    await db.delete(STORE_SECRETS, name);
  },
};
