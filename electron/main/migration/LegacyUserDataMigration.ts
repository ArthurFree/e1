/**
 * R009 Stage 1（§1.2 / G3）：LegacyUserDataMigration——产品身份冻结
 * （name=e1、app.setName("E1")，见 main.ts）后，Electron 默认 userData
 * 目录由旧名变为新名（macOS：~/Library/Application Support/
 * notion-like-web → E1），必须一次性迁移既有本地数据，避免用户感觉
 * 「数据全部丢失」。
 *
 * 迁移清单（§G3）：
 * - recent-vaults.json（最近 Vault 注册表）
 * - vault-state/（设备级交互状态，整目录）
 * - secrets.json（safeStorage 密文——只整体复制文件，绝不读内容、不落日志）
 * 不迁 search-index/：派生数据，库缺失/损坏时 DesktopSearchDatabase
 * 自动备份重建（R008 Stage 4/6 已落地该行为）。
 *
 * 约束（§1.2）：
 * - 幂等：marker 存在即 no-op；逐条目「目标已存在则跳过」，重跑不覆盖；
 * - 可中断重试：条目先复制到 <名>.migrating 临时位置再 rename 就位，
 *   半成品临时位置下次运行先清理重来；任一条目失败不写 marker，
 *   下次启动自动重试；
 * - 不损坏 legacy：全程只读 legacy（复制而非移动），失败保留原样；
 * - 不覆盖已有新数据：目标已存在的条目整体跳过；
 * - marker：迁移全部成功后写 {version: 1, migratedAt}。
 *
 * legacy 路径推导：Electron 默认 userData = appData/<app name>，旧
 * package name 为 notion-like-web 且无 productName，故 legacy =
 * appData/notion-like-web（macOS appData=~/Library/Application Support，
 * Windows=%APPDATA%，Linux=~/.config，同一规则覆盖三端）。
 *
 * 本模块不 import electron（路径全部注入），便于 Vitest 直接测试。
 */
import {
  cp,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

/** 旧 package name——legacy userData = <appData>/<LEGACY_APP_NAME>。 */
export const LEGACY_APP_NAME = "notion-like-web";

/** 迁移 marker 文件名（落新 userData 根，不与迁移清单条目重名）。 */
export const MIGRATION_MARKER_FILE = "e1-userdata-migration.json";

/** 迁移格式版本（未来迁移规则演进时递增）。 */
export const MIGRATION_VERSION = 1;

/** 迁移清单；search-index/ 为派生数据刻意不迁（启动后按需重建）。 */
const MIGRATED_ENTRIES = ["recent-vaults.json", "secrets.json", "vault-state"];

export type MigrationStatus =
  /** 本次执行了迁移（copied/skippedExisting 可能为空——legacy 里没有对应条目）。 */
  | "migrated"
  /** marker 已存在，幂等 no-op。 */
  | "already-migrated"
  /** legacy userData 不存在，无事可迁（不写 marker）。 */
  | "no-legacy"
  /** E1_USER_DATA_DIR 显式设置（测试隔离），跳过迁移。 */
  | "skipped-env-override"
  /** 有条目复制失败（未写 marker，下次启动重试；legacy 保持原样）。 */
  | "partial-failure";

export interface MigrationResult {
  status: MigrationStatus;
  /** 本次成功复制就位的条目名。 */
  copied: string[];
  /** 目标已存在而跳过（不覆盖已有新数据）的条目名。 */
  skippedExisting: string[];
  /** 复制失败的条目名。 */
  failed: string[];
}

function emptyResult(status: MigrationStatus): MigrationResult {
  return { status, copied: [], skippedExisting: [], failed: [] };
}

export interface LegacyUserDataMigrationOptions {
  /** 新 userData 目录（app.getPath("userData")）。 */
  newUserDataDir: string;
  /** legacy userData 目录（appData/<LEGACY_APP_NAME>）。 */
  legacyUserDataDir: string;
  /** 时钟注入（测试用；marker 的 migratedAt）。 */
  now?: () => Date;
  /** 日志出口——只传条目名与错误消息，绝不传文件内容（secrets.json）。 */
  log?: (message: string) => void;
}

export class LegacyUserDataMigration {
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(private readonly options: LegacyUserDataMigrationOptions) {
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
  }

  async run(): Promise<MigrationResult> {
    const { newUserDataDir, legacyUserDataDir } = this.options;

    // 幂等：marker 存在（且版本达标）即已完成过迁移。
    if (await this.hasMarker()) return emptyResult("already-migrated");

    // legacy 不存在 → 无事可迁（不写 marker：将来也不会凭空出现，
    // 每次启动一次 stat 的开销可忽略）。
    const legacyStat = await lstat(legacyUserDataDir).catch(() => null);
    if (!legacyStat?.isDirectory()) return emptyResult("no-legacy");

    await mkdir(newUserDataDir, { recursive: true });

    const result: MigrationResult = {
      status: "migrated",
      copied: [],
      skippedExisting: [],
      failed: [],
    };
    for (const entry of MIGRATED_ENTRIES) {
      try {
        await this.copyEntry(entry, result);
      } catch (error) {
        // 单条目失败：记录条目名与错误消息（不含任何文件内容），
        // 继续其余条目；legacy 全程只读，保持原样。
        result.failed.push(entry);
        const message = error instanceof Error ? error.message : String(error);
        this.log(`[LegacyUserDataMigration] 迁移 ${entry} 失败：${message}`);
      }
    }

    // 有失败 → 不写 marker，下次启动重试（已就位的条目经
    // skippedExisting 幂等跳过）。
    if (result.failed.length > 0) {
      result.status = "partial-failure";
      return result;
    }

    await this.writeMarker();
    return result;
  }

  /** 复制单条目：目标已存在则跳过；经 .migrating 临时位置 + rename 就位。 */
  private async copyEntry(
    entry: string,
    result: MigrationResult,
  ): Promise<void> {
    const { newUserDataDir, legacyUserDataDir } = this.options;
    const src = join(legacyUserDataDir, entry);
    const dest = join(newUserDataDir, entry);

    const srcStat = await lstat(src).catch(() => null);
    if (!srcStat) return; // legacy 无此条目，无需迁移。

    // 不覆盖已有新数据：目标已存在（文件或目录）即整体跳过。
    if (await lstat(dest).catch(() => null)) {
      result.skippedExisting.push(entry);
      return;
    }

    // 先复制到临时位置再 rename：中断只留半成品临时位置（下次运行
    // 开头清理重来），dest 要么不存在、要么是完整副本。
    const tmp = `${dest}.migrating`;
    await rm(tmp, { recursive: true, force: true });
    if (srcStat.isDirectory()) {
      await cp(src, tmp, { recursive: true });
    } else {
      await copyFile(src, tmp);
    }
    await rename(tmp, dest);
    result.copied.push(entry);
  }

  /** marker 存在且 version 达标 → 已迁移过（损坏 JSON 视为未迁移，重跑安全）。 */
  private async hasMarker(): Promise<boolean> {
    const markerPath = join(this.options.newUserDataDir, MIGRATION_MARKER_FILE);
    try {
      const parsed: unknown = JSON.parse(await readFile(markerPath, "utf8"));
      return (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as { version?: unknown }).version === "number" &&
        (parsed as { version: number }).version >= MIGRATION_VERSION
      );
    } catch {
      return false;
    }
  }

  /** 写迁移 marker：tmp + rename，避免半截文件。 */
  private async writeMarker(): Promise<void> {
    const markerPath = join(this.options.newUserDataDir, MIGRATION_MARKER_FILE);
    const body = `${JSON.stringify(
      { version: MIGRATION_VERSION, migratedAt: this.now().toISOString() },
      null,
      2,
    )}\n`;
    const tmp = `${markerPath}.tmp`;
    await writeFile(tmp, body, "utf8");
    await rename(tmp, markerPath);
  }
}

export interface RunLegacyUserDataMigrationOptions {
  /** 新 userData 目录（app.getPath("userData")）。 */
  userDataDir: string;
  /** app.getPath("appData")——legacy userData 的父目录。 */
  appDataDir: string;
  /** 环境变量注入（测试用）；显式设置 E1_USER_DATA_DIR 时跳过迁移。 */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  log?: (message: string) => void;
}

/**
 * 启动编排入口（main.ts 在 registerIpcHandlers 之前调用）：
 * E1_USER_DATA_DIR 显式设置（桌面 E2E 测试隔离）时跳过迁移；
 * 否则按 appData/<LEGACY_APP_NAME> 推导 legacy 目录并执行。
 */
export async function runLegacyUserDataMigration(
  options: RunLegacyUserDataMigrationOptions,
): Promise<MigrationResult> {
  const env = options.env ?? process.env;
  if (env.E1_USER_DATA_DIR) {
    return emptyResult("skipped-env-override");
  }
  return new LegacyUserDataMigration({
    newUserDataDir: options.userDataDir,
    legacyUserDataDir: join(options.appDataDir, LEGACY_APP_NAME),
    now: options.now,
    log: options.log,
  }).run();
}
