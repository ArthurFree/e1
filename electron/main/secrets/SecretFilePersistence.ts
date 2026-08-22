/**
 * R008 Stage 1（§8.4/§8.5，G2）：Desktop 机密文件持久化——AI API Key
 * 等机密经 Electron safeStorage 加密后落 userData/secrets.json
 *（value 为密文 base64，磁盘上永无明文/弱保护）。
 *
 * 由 R007 阶段 5 的 state/DesktopSecretPersistence 迁移并按 R008 对齐：
 * - 文件格式 { version: 1, entries: { <name>: { ciphertext, updatedAt } } }；
 *   读兼容 R007 阶段 5 的 { secrets: { <name>: <base64> } }（静默迁移，
 *   下次写盘即新格式）；
 * - 优先 async 接口（encryptStringAsync/decryptStringAsync，Electron 43+），
 *   缺省回退同步接口；decryptStringAsync 报告 shouldReEncrypt 时重写该条；
 * - 持久化与否由 SecretBackendStatus 决定（secure-persistent 才落盘）；
 *   session-only / unavailable 一律进程内存（会话级），绝不弱保护落盘；
 * - 容错：文件缺失视为空表；JSON 损坏或顶层形状非法时备份原文件
 *   （<file>.corrupt-<时间戳>）后重置为空表——未知 schema version 同样
 *   先备份再自愈，原内容保留在备份中不被湮灭；单条记录无法解密
 *   （他机复制/密钥链变更）按缺失处理；写入走 mkdir -p + tmp + rename。
 *
 * 安全约束（R008 §15.2）：机密值不进日志、不进 error details、不进 Vault。
 */
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { IpcFailure } from "../../../shared/errors.js";
import type { SecretStorageMode } from "../../../shared/ipc/contracts.js";

/** Electron safeStorage 的最小结构视图（测试可注入 mock；async 优先）。 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** R008 §8.5：Electron 43+ 异步接口，存在时优先。 */
  encryptStringAsync?(plainText: string): Promise<Buffer>;
  decryptStringAsync?(
    encrypted: Buffer,
  ): Promise<{ shouldReEncrypt: boolean; result: string }>;
  /** Linux 密码管理后端（@platform linux；其他平台可为空）。 */
  getSelectedStorageBackend?(): string;
}

/** secrets.json 条目：密文 base64 + 写入时间。 */
interface SecretEntry {
  ciphertext: string;
  updatedAt: number;
}

/** secrets.json 的磁盘形状：version 固定 1。 */
interface SecretsFile {
  version: 1;
  entries: Record<string, SecretEntry>;
}

export class SecretFilePersistence {
  /** 非 secure-persistent 时的会话内存降级（不落盘）。 */
  private readonly sessionFallback = new Map<string, string>();

  constructor(
    private readonly filePath: string,
    private readonly safeStorage: SafeStorageLike,
    private readonly mode: () => SecretStorageMode,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 当前是否安全持久化（false → 读写走会话内存）。 */
  private isPersistent(): boolean {
    return this.mode() === "secure-persistent";
  }

  /** 读取 secret；不存在/无法解密（记录损坏或密钥链变更）返回 null。 */
  async get(name: string): Promise<string | null> {
    if (!this.isPersistent()) return this.sessionFallback.get(name) ?? null;
    const table = await this.readTable();
    const entry = table.entries[name];
    if (!entry || typeof entry.ciphertext !== "string") return null;
    try {
      return await this.decrypt(entry.ciphertext, name, table);
    } catch {
      // 单条损坏按缺失处理（他机复制的密文本机解不开属预期场景）。
      return null;
    }
  }

  /** 写入（覆盖）secret。 */
  async set(name: string, value: string): Promise<void> {
    if (!this.isPersistent()) {
      this.sessionFallback.set(name, value);
      return;
    }
    let encrypted: Buffer;
    try {
      encrypted = this.safeStorage.encryptStringAsync
        ? await this.safeStorage.encryptStringAsync(value)
        : this.safeStorage.encryptString(value);
    } catch {
      throw new IpcFailure(
        "SECRET_STORAGE_UNAVAILABLE",
        "系统安全存储不可用，无法保存机密。",
      );
    }
    const table = await this.readTable();
    table.entries[name] = {
      ciphertext: encrypted.toString("base64"),
      updatedAt: this.now(),
    };
    await this.writeTable(table);
  }

  /** 删除 secret；对缺失记录为 no-op。 */
  async remove(name: string): Promise<void> {
    if (!this.isPersistent()) {
      this.sessionFallback.delete(name);
      return;
    }
    const table = await this.readTable();
    if (!(name in table.entries)) return;
    delete table.entries[name];
    await this.writeTable(table);
  }

  /** 解密单条；async 接口报告 shouldReEncrypt 时顺带重写该条（密钥轮换）。 */
  private async decrypt(
    ciphertext: string,
    name: string,
    table: SecretsFile,
  ): Promise<string> {
    const bytes = Buffer.from(ciphertext, "base64");
    if (this.safeStorage.decryptStringAsync) {
      const { shouldReEncrypt, result } =
        await this.safeStorage.decryptStringAsync(bytes);
      if (shouldReEncrypt && this.safeStorage.encryptStringAsync) {
        const reEncrypted = await this.safeStorage.encryptStringAsync(result);
        table.entries[name] = {
          ciphertext: reEncrypted.toString("base64"),
          updatedAt: this.now(),
        };
        await this.writeTable(table).catch(() => undefined);
      }
      return result;
    }
    return this.safeStorage.decryptString(bytes);
  }

  /** 读表；缺失 → 空表；损坏/未知版本 → 备份后空表（自愈，原内容留备份）。 */
  private async readTable(): Promise<SecretsFile> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return { version: 1, entries: {} };
    }
    try {
      return sanitizeSecretsFile(JSON.parse(raw));
    } catch {
      const backup = `${this.filePath}.corrupt-${this.now()}`;
      await copyFile(this.filePath, backup).catch(() => undefined);
      return { version: 1, entries: {} };
    }
  }

  /** 落盘：mkdir -p + tmp 文件 + rename 替换（防半截文件）。 */
  private async writeTable(table: SecretsFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(table, null, 2)}\n`, "utf8");
    await rename(tmp, this.filePath);
  }
}

/**
 * 顶层形状校验 + R007 阶段 5 旧格式（{ secrets: { name: base64 } }）迁移；
 * 非法即抛（调用方走备份自愈）。
 */
function sanitizeSecretsFile(value: unknown): SecretsFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("顶层不是对象");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new Error("version 不是 1");
  const table: SecretsFile = { version: 1, entries: {} };
  // R007 阶段 5 旧格式迁移：secrets: { name: base64 } → entries。
  if (
    typeof record.secrets === "object" &&
    record.secrets !== null &&
    !Array.isArray(record.secrets)
  ) {
    for (const [name, ciphertext] of Object.entries(
      record.secrets as Record<string, unknown>,
    )) {
      if (typeof ciphertext === "string") {
        table.entries[name] = { ciphertext, updatedAt: 0 };
      }
    }
    return table;
  }
  if (
    typeof record.entries !== "object" ||
    record.entries === null ||
    Array.isArray(record.entries)
  ) {
    throw new Error("entries 不是对象");
  }
  for (const [name, entry] of Object.entries(
    record.entries as Record<string, unknown>,
  )) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.ciphertext !== "string") continue;
    table.entries[name] = {
      ciphertext: e.ciphertext,
      updatedAt:
        typeof e.updatedAt === "number" && Number.isFinite(e.updatedAt)
          ? e.updatedAt
          : 0,
    };
  }
  return table;
}
