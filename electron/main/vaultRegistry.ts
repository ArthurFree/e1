/**
 * R006 阶段 2：最近 Vault 注册表（r006 US-06）。
 *
 * 存储于 Electron userData 下的 recent-vaults.json，记录
 * {vaultId, absolutePath, displayName, lastOpenedAt}：
 * - touch：打开成功时登记——同 absolutePath 去重置顶，按 lastOpenedAt
 *   倒序，上限 10 条；
 * - list：目录不存在时不删记录（「重新定位」属阶段 6），仅附带
 *   accessible: false 供 UI 提示「原知识库目录已移动或不可访问」；
 * - findByVaultId：vault.scan 等接口按 vaultId 解析 Vault 根用。
 *
 * 容错：文件缺失视为空表；JSON 损坏或顶层形状非法时备份原文件
 * （recent-vaults.json.corrupt-<时间戳>）后重置为空表，不抛错阻断启动。
 * 写入走 tmp + rename 替换，避免半截文件。
 */
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import type { RecentVault } from "../../shared/ipc/contracts.js";

/** 注册表落盘记录（accessible 是 list 时的派生字段，不落盘）。 */
export interface RecentVaultRecord {
  vaultId: string;
  absolutePath: string;
  displayName: string;
  lastOpenedAt: string;
}

const MAX_ENTRIES = 10;

export class VaultRegistry {
  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 最近列表（lastOpenedAt 倒序——落盘即有序），附带目录可达性。 */
  async list(): Promise<RecentVault[]> {
    const records = await this.read();
    return Promise.all(
      records.map(async (record) => ({
        ...record,
        accessible: await this.isAccessible(record.absolutePath),
      })),
    );
  }

  /** 登记一次打开：同 absolutePath 去重置顶，截断到 10 条。 */
  async touch(entry: {
    vaultId: string;
    absolutePath: string;
    displayName: string;
  }): Promise<void> {
    const records = await this.read();
    const rest = records.filter((r) => r.absolutePath !== entry.absolutePath);
    rest.unshift({ ...entry, lastOpenedAt: this.now().toISOString() });
    await this.write(rest.slice(0, MAX_ENTRIES));
  }

  /** 按 vaultId 查记录（vault.scan 解析根目录用）；未登记返回 null。 */
  async findByVaultId(vaultId: string): Promise<RecentVaultRecord | null> {
    const records = await this.read();
    return records.find((r) => r.vaultId === vaultId) ?? null;
  }

  private async isAccessible(absolutePath: string): Promise<boolean> {
    try {
      return (await stat(absolutePath)).isDirectory();
    } catch {
      return false;
    }
  }

  /** 读取落盘表；缺失 → 空表；损坏 → 备份原文件后返回空表。 */
  private async read(): Promise<RecentVaultRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("顶层不是数组");
      // 逐条校验形状，丢弃畸形条目（不整体判损坏——能救多少救多少）。
      return parsed.filter(isRecentVaultRecord);
    } catch {
      const backup = `${this.filePath}.corrupt-${this.now().getTime()}`;
      await copyFile(this.filePath, backup).catch(() => undefined);
      return [];
    }
  }

  /** 落盘：mkdir -p + tmp 文件 + rename 替换。 */
  private async write(records: RecentVaultRecord[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(records, null, 2)}\n`, "utf8");
    await rename(tmp, this.filePath);
  }
}

function isRecentVaultRecord(value: unknown): value is RecentVaultRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const r = value as Record<string, unknown>;
  return (
    typeof r.vaultId === "string" &&
    typeof r.absolutePath === "string" &&
    typeof r.displayName === "string" &&
    typeof r.lastOpenedAt === "string"
  );
}
