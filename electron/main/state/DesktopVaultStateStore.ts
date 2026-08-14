/**
 * R007 阶段 2（DSK-04）：Vault 设备级交互状态存储。
 *
 * 收藏（favoriteAt）/最近打开（lastOpenedAt）是设备级交互状态——不属于
 * 用户 Markdown 内容、不参与 portable truth、不应被第三方工具看到，
 * 因此持久化在 Electron userData/vault-state/<vaultId>.json，而不是
 * Vault 内（Vault 目录被复制到他机不会携带本机记录）。
 *
 * 形状见 shared/ipc/contracts.ts 的 VaultState：
 * { version: 1, pages: { <stableNoteId|path:...>: {...} }, workspace: {...} }。
 *
 * 容错与 vaultRegistry 同口径：文件缺失视为空表；JSON 损坏或顶层形状
 * 非法时备份原文件（<file>.corrupt-<时间戳>）后重置为空表，不抛错阻断
 * Vault 打开（验收：state 损坏自动自愈）；逐条丢弃畸形页面条目（能救
 * 多少救多少）。写入走 mkdir -p + tmp 文件 + rename 替换，避免半截文件。
 */
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { IpcFailure } from "../../../shared/errors.js";
import {
  createEmptyVaultState,
  type VaultPageState,
  type VaultState,
  type VaultStatePatch,
} from "../../../shared/ipc/contracts.js";

/**
 * vaultId 直接拼文件名，必须是文件名片段——拒绝路径分隔符/逃逸段。
 * Main 生成的 vaultId（ULID/uuid）天然满足；恶意 vault.json 携带的
 * 异常 id 在注册表登记前就被 vault.scan 校验拒绝，这里是纵深防御。
 */
const SAFE_FILE_STEM = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export class DesktopVaultStateStore {
  constructor(
    private readonly baseDir: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private filePath(vaultId: string): string {
    if (!SAFE_FILE_STEM.test(vaultId)) {
      throw new IpcFailure(
        "INVALID_INPUT",
        `vaultId 不是合法的状态文件名片段：${vaultId}`,
      );
    }
    return join(this.baseDir, `${vaultId}.json`);
  }

  /** 读取状态；缺失/损坏 → 空表（损坏文件备份后重置）。 */
  async get(vaultId: string): Promise<VaultState> {
    const path = this.filePath(vaultId);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return createEmptyVaultState();
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return sanitizeVaultState(parsed);
    } catch {
      const backup = `${path}.corrupt-${this.now()}`;
      await copyFile(path, backup).catch(() => undefined);
      return createEmptyVaultState();
    }
  }

  /**
   * 局部合并：缺省键保持原值；显式 null 清空字段；pages 中字段全缺省
   * 的空补丁不新建条目。返回合并后的完整状态（供 Renderer 镜像对账）。
   */
  async patch(vaultId: string, patch: VaultStatePatch): Promise<VaultState> {
    const state = await this.get(vaultId);
    if (patch.workspace && patch.workspace.favoriteAt !== undefined) {
      state.workspace.favoriteAt = patch.workspace.favoriteAt;
    }
    if (patch.pages) {
      for (const [key, pagePatch] of Object.entries(patch.pages)) {
        const existing = state.pages[key];
        if (!existing) {
          if (
            pagePatch.favoriteAt === undefined &&
            pagePatch.lastOpenedAt === undefined
          ) {
            continue;
          }
          state.pages[key] = {
            favoriteAt: pagePatch.favoriteAt ?? null,
            lastOpenedAt: pagePatch.lastOpenedAt ?? null,
          };
          continue;
        }
        if (pagePatch.favoriteAt !== undefined) {
          existing.favoriteAt = pagePatch.favoriteAt;
        }
        if (pagePatch.lastOpenedAt !== undefined) {
          existing.lastOpenedAt = pagePatch.lastOpenedAt;
        }
      }
    }
    await this.write(this.filePath(vaultId), state);
    return state;
  }

  /** 落盘：mkdir -p + tmp 文件 + rename 替换。 */
  private async write(path: string, state: VaultState): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tmp, path);
  }
}

/** 顶层形状校验 + 逐条过滤畸形页面条目；非法即抛（调用方走损坏自愈）。 */
function sanitizeVaultState(value: unknown): VaultState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("顶层不是对象");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new Error("version 不是 1");
  const state = createEmptyVaultState();
  if (
    typeof record.workspace === "object" &&
    record.workspace !== null &&
    !Array.isArray(record.workspace)
  ) {
    const favoriteAt = (record.workspace as Record<string, unknown>)
      .favoriteAt;
    if (isNullableTimestamp(favoriteAt)) {
      state.workspace.favoriteAt = favoriteAt;
    }
  }
  if (
    typeof record.pages === "object" &&
    record.pages !== null &&
    !Array.isArray(record.pages)
  ) {
    for (const [key, entry] of Object.entries(record.pages)) {
      const page = sanitizePageState(entry);
      if (page) state.pages[key] = page;
    }
  }
  return state;
}

function sanitizePageState(value: unknown): VaultPageState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    !isNullableTimestamp(record.favoriteAt) ||
    !isNullableTimestamp(record.lastOpenedAt)
  ) {
    return null;
  }
  return { favoriteAt: record.favoriteAt, lastOpenedAt: record.lastOpenedAt };
}

function isNullableTimestamp(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      Number.isInteger(value) &&
      value >= 0)
  );
}
