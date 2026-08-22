/**
 * R007 阶段 5（§5.1，G3）：Desktop 机密持久化——AI API Key 等机密经
 * Electron safeStorage 加密后落 userData/secrets.json（value 为
 * safeStorage.encryptString 结果的 base64，磁盘上永无明文）。
 *
 * 降级口径（R007 §5.1）：safeStorage.isEncryptionAvailable() === false
 * 时降级为进程内存（会话级，重启丢失），绝不明文落盘、不伪装为安全——
 * available=false 经 secret.status 上报，Renderer 把
 * capabilities.nativeSecrets 置 false 并在设置页提示「本次会话使用」。
 *
 * 容错与 DesktopVaultStateStore 同口径：文件缺失视为空表；JSON 损坏或
 * 顶层形状非法时备份原文件（<file>.corrupt-<时间戳>）后重置为空表，
 * 不抛错阻断应用启动；单条记录无法解密（他机复制/密钥链变更）按缺失
 * 处理（get 返回 null）。写入走 mkdir -p + tmp 文件 + rename 替换。
 *
 * 安全约束（R007 §15）：机密值不进日志、不进 error details、不进 Vault。
 */
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { IpcFailure } from "../../../shared/errors.js";

/** Electron safeStorage 的最小结构视图（测试可注入 mock）。 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** secrets.json 的磁盘形状：version 固定 1；value 为密文 base64。 */
interface SecretsFile {
  version: 1;
  secrets: Record<string, string>;
}

export class DesktopSecretPersistence {
  /** 安全存储不可用时的会话内存降级（不落盘）。 */
  private readonly sessionFallback = new Map<string, string>();

  constructor(
    private readonly filePath: string,
    private readonly safeStorage: SafeStorageLike,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 系统安全存储当前是否可用（false → 本实例读写走会话内存）。 */
  isAvailable(): boolean {
    try {
      return this.safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  /** 读取 secret；不存在/无法解密（记录损坏或密钥链变更）返回 null。 */
  async get(name: string): Promise<string | null> {
    if (!this.isAvailable()) return this.sessionFallback.get(name) ?? null;
    const table = await this.readTable();
    const encoded = table.secrets[name];
    if (typeof encoded !== "string") return null;
    try {
      return this.safeStorage.decryptString(Buffer.from(encoded, "base64"));
    } catch {
      // 单条损坏按缺失处理（他机复制的密文本机解不开属预期场景）。
      return null;
    }
  }

  /** 写入（覆盖）secret。 */
  async set(name: string, value: string): Promise<void> {
    if (!this.isAvailable()) {
      this.sessionFallback.set(name, value);
      return;
    }
    let encrypted: Buffer;
    try {
      encrypted = this.safeStorage.encryptString(value);
    } catch {
      throw new IpcFailure(
        "SECRET_STORAGE_UNAVAILABLE",
        "系统安全存储不可用，无法保存机密。",
      );
    }
    const table = await this.readTable();
    table.secrets[name] = encrypted.toString("base64");
    await this.writeTable(table);
  }

  /** 删除 secret；对缺失记录为 no-op。 */
  async remove(name: string): Promise<void> {
    if (!this.isAvailable()) {
      this.sessionFallback.delete(name);
      return;
    }
    const table = await this.readTable();
    if (!(name in table.secrets)) return;
    delete table.secrets[name];
    await this.writeTable(table);
  }

  /** 读表；缺失 → 空表；损坏 → 备份后空表（自愈口径同 VaultStateStore）。 */
  private async readTable(): Promise<SecretsFile> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return { version: 1, secrets: {} };
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        (parsed as Record<string, unknown>).version !== 1 ||
        typeof (parsed as Record<string, unknown>).secrets !== "object" ||
        (parsed as Record<string, unknown>).secrets === null
      ) {
        throw new Error("secrets 文件形状非法");
      }
      return parsed as SecretsFile;
    } catch {
      const backup = `${this.filePath}.corrupt-${this.now()}`;
      await copyFile(this.filePath, backup).catch(() => undefined);
      return { version: 1, secrets: {} };
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
