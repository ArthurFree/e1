/**
 * R008 Stage 1（§8.4）：secret 密文文件持久化。
 *
 * 文件：userData/secrets.json，形状：
 *   { version: 1, entries: { <name>: { ciphertext: <base64>, updatedAt } } }
 *
 * 只存 safeStorage 加密后的 base64 密文，绝不写明文（§8.4）。
 *
 * 容错与 DesktopVaultStateStore 同口径：
 * - 文件缺失 → 空表；
 * - JSON 损坏 / 顶层形状非法 / version 未知 → 备份原文件
 *   （<file>.corrupt-<时间戳>）后按空表继续（自愈，不抛错阻断）——
 *   原文件字节在备份中保留（unknown version 不被覆盖丢弃）；
 * - 逐条丢弃畸形条目（能救多少救多少）；
 * - 写入走 mkdir -p + tmp 文件 + rename 替换，避免半截文件；
 *   落盘后 best-effort chmod 0o600（密文文件不应被其他用户读取）。
 */
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

interface SecretEntry {
  ciphertext: string;
  updatedAt: number;
}

interface SecretsFile {
  version: 1;
  entries: Record<string, SecretEntry>;
}

function createEmptySecretsFile(): SecretsFile {
  return { version: 1, entries: {} };
}

export class SecretFilePersistence {
  constructor(
    private readonly filePath: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 读取指定 name 的密文（base64）；文件/条目缺失或损坏返回 null。 */
  async getCiphertext(name: string): Promise<string | null> {
    const table = await this.load();
    return table.entries[name]?.ciphertext ?? null;
  }

  /** 写入（覆盖）条目并整体落盘。 */
  async put(name: string, ciphertext: string): Promise<void> {
    const table = await this.load();
    table.entries[name] = { ciphertext, updatedAt: this.now() };
    await this.write(table);
  }

  /** 删除条目；缺失为 no-op（不写文件）。 */
  async delete(name: string): Promise<void> {
    const table = await this.load();
    if (!(name in table.entries)) return;
    delete table.entries[name];
    await this.write(table);
  }

  /** 读取整表；缺失 → 空表；损坏/未知 version → 备份后空表（自愈）。 */
  private async load(): Promise<SecretsFile> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return createEmptySecretsFile();
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return sanitizeSecretsFile(parsed);
    } catch {
      const backup = `${this.filePath}.corrupt-${this.now()}`;
      await copyFile(this.filePath, backup).catch(() => undefined);
      return createEmptySecretsFile();
    }
  }

  /** 落盘：mkdir -p + tmp 文件 + rename 替换 + best-effort 0o600。 */
  private async write(table: SecretsFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(table, null, 2)}\n`, "utf8");
    await rename(tmp, this.filePath);
    await chmod(this.filePath, 0o600).catch(() => undefined);
  }
}

/** 顶层形状校验 + 逐条过滤畸形条目；version 未知/形状非法即抛（走自愈）。 */
function sanitizeSecretsFile(value: unknown): SecretsFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("顶层不是对象");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new Error("version 不是 1");
  const table = createEmptySecretsFile();
  if (
    typeof record.entries === "object" &&
    record.entries !== null &&
    !Array.isArray(record.entries)
  ) {
    for (const [name, entry] of Object.entries(record.entries)) {
      const sanitized = sanitizeEntry(entry);
      if (sanitized) table.entries[name] = sanitized;
    }
  }
  return table;
}

function sanitizeEntry(value: unknown): SecretEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.ciphertext !== "string" || record.ciphertext === "") {
    return null;
  }
  if (
    typeof record.updatedAt !== "number" ||
    !Number.isFinite(record.updatedAt) ||
    !Number.isInteger(record.updatedAt) ||
    record.updatedAt < 0
  ) {
    return null;
  }
  return { ciphertext: record.ciphertext, updatedAt: record.updatedAt };
}
