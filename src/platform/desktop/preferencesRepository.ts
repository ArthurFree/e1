/**
 * R006 阶段 2（C2）：Desktop 偏好仓储——localStorage 实现。
 *
 * 取舍：偏好（主题/侧栏宽度/AI 非机密配置/lastRoute）不属 Vault 数据，
 * 不写入知识库目录；localStorage 在 Electron renderer 随 userData 持久化，
 * 足以支撑「重开应用自动进入最近使用的 Vault」（US-06 的路由恢复）。
 * platform 层使用 localStorage 有先例（platform/web/webRecoveryStore），
 * 且application 层「不直接碰 localStorage」的约束不覆盖平台适配边界。
 * 与 Web 偏好（IndexedDB）互不影响：键名独立、数据模型各自校验。
 */
import type { PreferencesRepository } from "../../domain/repositories";
import { DEFAULT_PREFERENCES, type Preferences } from "../../domain/types";

/** localStorage 键：带平台前缀，避免与未来其他用途冲突。 */
const STORAGE_KEY = "e1:desktop-preferences";

export class DesktopPreferencesRepository implements PreferencesRepository {
  async get(): Promise<Preferences> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_PREFERENCES };
      const parsed = JSON.parse(raw) as Partial<Preferences>;
      if (typeof parsed !== "object" || parsed === null) {
        return { ...DEFAULT_PREFERENCES };
      }
      // 与默认值合并：缺字段/新增字段都有回退，损坏字段由调用方覆盖。
      return { ...DEFAULT_PREFERENCES, ...parsed, id: "preferences" };
    } catch {
      // 解析失败按损坏处理：回退默认偏好，不阻塞启动。
      return { ...DEFAULT_PREFERENCES };
    }
  }

  async update(patch: Partial<Omit<Preferences, "id">>): Promise<Preferences> {
    const next = {
      ...(await this.get()),
      ...patch,
      id: "preferences" as const,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (err) {
      // 偏好写入失败只告警（与 Web 恢复缓冲同约定：降级不致命）。
      console.warn("桌面端偏好写入失败", err);
    }
    return next;
  }
}
