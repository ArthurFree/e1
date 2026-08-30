// @vitest-environment node
/**
 * R009 Stage 1（§1.2 / G3）：LegacyUserDataMigration 测试（真实 tmp 文件
 * 系统，注入目录路径，不碰真实 ~/Library）。
 * 覆盖：迁移成功（文件+目录+marker 内容）、幂等（二次运行 no-op）、
 * 新数据已存在不覆盖、单条目失败保留 legacy 且重试可完成、
 * legacy 不存在 no-legacy、E1_USER_DATA_DIR 显式设置跳过。
 */
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEGACY_APP_NAME,
  LegacyUserDataMigration,
  MIGRATION_MARKER_FILE,
  MIGRATION_VERSION,
  runLegacyUserDataMigration,
} from "./LegacyUserDataMigration.js";

const FIXED_NOW = new Date("2026-08-30T07:00:00.000Z");

/** 构造 appData/<旧名> 作为 legacy、appData/<新名> 作为新 userData。 */
async function makeDirs(): Promise<{
  root: string;
  appData: string;
  legacyDir: string;
  newDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "e1-migration-"));
  const appData = join(root, "appData");
  const legacyDir = join(appData, LEGACY_APP_NAME);
  const newDir = join(appData, "E1");
  await mkdir(legacyDir, { recursive: true });
  return { root, appData, legacyDir, newDir };
}

/** 在 legacy 写入完整的三类数据。 */
async function seedLegacy(legacyDir: string): Promise<void> {
  await writeFile(
    join(legacyDir, "recent-vaults.json"),
    '[{"vaultId":"v1"}]\n',
    "utf8",
  );
  await writeFile(
    join(legacyDir, "secrets.json"),
    '{"k":"ciphertext"}\n',
    "utf8",
  );
  await mkdir(join(legacyDir, "vault-state"), { recursive: true });
  await writeFile(
    join(legacyDir, "vault-state", "v1.json"),
    '{"favorites":[]}\n',
    "utf8",
  );
  // 派生数据：应被刻意跳过。
  await mkdir(join(legacyDir, "search-index"), { recursive: true });
  await writeFile(
    join(legacyDir, "search-index", "v1.sqlite"),
    "sqlite",
    "utf8",
  );
}

function makeMigration(legacyDir: string, newDir: string) {
  const logs: string[] = [];
  const migration = new LegacyUserDataMigration({
    newUserDataDir: newDir,
    legacyUserDataDir: legacyDir,
    now: () => FIXED_NOW,
    log: (message) => logs.push(message),
  });
  return { migration, logs };
}

describe("LegacyUserDataMigration", () => {
  it("迁移成功：三类数据复制就位，search-index 不迁，marker 内容正确", async () => {
    const { legacyDir, newDir } = await makeDirs();
    await seedLegacy(legacyDir);

    const { migration } = makeMigration(legacyDir, newDir);
    const result = await migration.run();

    expect(result).toEqual({
      status: "migrated",
      copied: expect.arrayContaining([
        "recent-vaults.json",
        "secrets.json",
        "vault-state",
      ]),
      skippedExisting: [],
      failed: [],
    });
    expect(await readFile(join(newDir, "recent-vaults.json"), "utf8")).toBe(
      '[{"vaultId":"v1"}]\n',
    );
    expect(await readFile(join(newDir, "secrets.json"), "utf8")).toBe(
      '{"k":"ciphertext"}\n',
    );
    expect(await readFile(join(newDir, "vault-state", "v1.json"), "utf8")).toBe(
      '{"favorites":[]}\n',
    );
    // 派生数据不迁。
    await expect(
      readFile(join(newDir, "search-index", "v1.sqlite")),
    ).rejects.toThrow();
    // marker：{version: 1, migratedAt}。
    const marker = JSON.parse(
      await readFile(join(newDir, MIGRATION_MARKER_FILE), "utf8"),
    ) as { version: number; migratedAt: string };
    expect(marker).toEqual({
      version: MIGRATION_VERSION,
      migratedAt: FIXED_NOW.toISOString(),
    });
    // legacy 保持原样（只读复制）。
    expect(await readFile(join(legacyDir, "secrets.json"), "utf8")).toBe(
      '{"k":"ciphertext"}\n',
    );
  });

  it("幂等：二次运行 already-migrated，legacy 后续变更不再同步", async () => {
    const { legacyDir, newDir } = await makeDirs();
    await seedLegacy(legacyDir);
    const { migration } = makeMigration(legacyDir, newDir);

    await migration.run();
    // 迁移后 legacy 与 new 各自演化。
    await writeFile(join(legacyDir, "recent-vaults.json"), "[]\n", "utf8");
    await writeFile(
      join(newDir, "recent-vaults.json"),
      '[{"vaultId":"v2"}]\n',
      "utf8",
    );

    const second = await migration.run();
    expect(second.status).toBe("already-migrated");
    expect(second.copied).toEqual([]);
    // new 数据未被 legacy 覆盖。
    expect(await readFile(join(newDir, "recent-vaults.json"), "utf8")).toBe(
      '[{"vaultId":"v2"}]\n',
    );
  });

  it("不覆盖已有新数据：目标已存在的条目跳过，其余条目仍迁移", async () => {
    const { legacyDir, newDir } = await makeDirs();
    await seedLegacy(legacyDir);
    await mkdir(newDir, { recursive: true });
    await writeFile(
      join(newDir, "recent-vaults.json"),
      '[{"vaultId":"new"}]\n',
      "utf8",
    );

    const { migration } = makeMigration(legacyDir, newDir);
    const result = await migration.run();

    expect(result.status).toBe("migrated");
    expect(result.skippedExisting).toEqual(["recent-vaults.json"]);
    expect(result.copied).toEqual(
      expect.arrayContaining(["secrets.json", "vault-state"]),
    );
    // 已有新数据原样保留。
    expect(await readFile(join(newDir, "recent-vaults.json"), "utf8")).toBe(
      '[{"vaultId":"new"}]\n',
    );
    // marker 照常写入（逐条目幂等，重跑也只会重复跳过）。
    const marker = JSON.parse(
      await readFile(join(newDir, MIGRATION_MARKER_FILE), "utf8"),
    ) as { version: number };
    expect(marker.version).toBe(MIGRATION_VERSION);
  });

  it("单条目失败：保留 legacy 原样、不写 marker，修复后重试完成", async () => {
    const { legacyDir, newDir } = await makeDirs();
    await seedLegacy(legacyDir);
    // 让 secrets.json 复制失败（POSIX EACCES）。
    const legacySecrets = join(legacyDir, "secrets.json");
    await chmod(legacySecrets, 0o000);

    try {
      const { migration, logs } = makeMigration(legacyDir, newDir);
      const first = await migration.run();

      expect(first.status).toBe("partial-failure");
      expect(first.failed).toEqual(["secrets.json"]);
      // 其余条目已就位。
      expect(first.copied).toEqual(
        expect.arrayContaining(["recent-vaults.json", "vault-state"]),
      );
      // 不写 marker → 下次启动重试。
      await expect(
        readFile(join(newDir, MIGRATION_MARKER_FILE)),
      ).rejects.toThrow();
      // 日志只含条目名与错误消息，不含 secrets 内容。
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("secrets.json");
      expect(logs[0]).not.toContain("ciphertext");
      // 中断半成品已清理（dest 不存在、无 .migrating 残留）。
      await expect(readFile(join(newDir, "secrets.json"))).rejects.toThrow();
      await expect(
        readFile(join(newDir, "secrets.json.migrating")),
      ).rejects.toThrow();
    } finally {
      await chmod(legacySecrets, 0o600);
    }

    // legacy 未受损坏，恢复可读后重试完成。
    expect(await readFile(legacySecrets, "utf8")).toBe('{"k":"ciphertext"}\n');
    const { migration } = makeMigration(legacyDir, newDir);
    const second = await migration.run();
    expect(second.status).toBe("migrated");
    // 已就位条目幂等跳过，只补 secrets.json。
    expect(second.skippedExisting).toEqual(
      expect.arrayContaining(["recent-vaults.json", "vault-state"]),
    );
    expect(second.copied).toEqual(["secrets.json"]);
    expect(await readFile(join(newDir, "secrets.json"), "utf8")).toBe(
      '{"k":"ciphertext"}\n',
    );
    const marker = JSON.parse(
      await readFile(join(newDir, MIGRATION_MARKER_FILE), "utf8"),
    ) as { version: number };
    expect(marker.version).toBe(MIGRATION_VERSION);
  });

  it("legacy 不存在 → no-legacy，不写 marker、不创建新目录以外的内容", async () => {
    const root = await mkdtemp(join(tmpdir(), "e1-migration-"));
    const legacyDir = join(root, "appData", LEGACY_APP_NAME);
    const newDir = join(root, "appData", "E1");

    const { migration } = makeMigration(legacyDir, newDir);
    const result = await migration.run();

    expect(result).toEqual({
      status: "no-legacy",
      copied: [],
      skippedExisting: [],
      failed: [],
    });
  });

  it("runLegacyUserDataMigration：E1_USER_DATA_DIR 显式设置时跳过", async () => {
    const { appData, legacyDir, newDir } = await makeDirs();
    await seedLegacy(legacyDir);

    const result = await runLegacyUserDataMigration({
      userDataDir: newDir,
      appDataDir: appData,
      env: { E1_USER_DATA_DIR: newDir },
      now: () => FIXED_NOW,
    });

    expect(result.status).toBe("skipped-env-override");
    // 新目录里什么都没有（连目录都不创建）。
    await expect(
      readFile(join(newDir, "recent-vaults.json")),
    ).rejects.toThrow();
  });

  it("runLegacyUserDataMigration：正常路径按 appData/<旧名> 推导 legacy", async () => {
    const { appData, legacyDir, newDir } = await makeDirs();
    await seedLegacy(legacyDir);

    const result = await runLegacyUserDataMigration({
      userDataDir: newDir,
      appDataDir: appData,
      env: {},
      now: () => FIXED_NOW,
    });

    expect(result.status).toBe("migrated");
    expect(await readFile(join(newDir, "recent-vaults.json"), "utf8")).toBe(
      '[{"vaultId":"v1"}]\n',
    );
  });
});
