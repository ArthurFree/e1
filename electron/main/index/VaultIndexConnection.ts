/**
 * R010 Stage 3（§17 实施决策）：per-vault 索引库单连接持有者——
 * Search 与 Link 两个逻辑表组共用同一 DatabaseSync（「一个物理连接 +
 * 两个逻辑表组」），避免两个连接指向同一文件产生 SQLITE_BUSY 写冲突。
 *
 * 职责仅限连接生命周期：懒打开（必要时建目录/建文件）、损坏/版本不兼容
 * 时的文件级自愈（备份 .corrupt-<ts> 后删除，表组下次 open 重建）。
 * 表组（notes/notes_fts、link_docs/links）各自的 DDL、meta 版本命名空间
 * 与状态机留在各 Database 类；文件级自愈后 generation 自增，表组据此
 * 失效并重初始化（派生数据原则：损坏一律备份重建，R8-03/LINK-03）。
 */
import { DatabaseSync } from "node:sqlite";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

export class VaultIndexConnection {
  private db: DatabaseSync | null = null;
  /** 文件级自愈代数：每次 recoverCorrupt 自增，表组据此重初始化。 */
  private generation = 0;

  constructor(
    readonly filePath: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get currentGeneration(): number {
    return this.generation;
  }

  /** 打开（必要时创建）数据库文件。 */
  async open(): Promise<DatabaseSync> {
    if (this.db) return this.db;
    await mkdir(dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    return this.db;
  }

  /**
   * 文件级自愈：关闭 → 备份 .corrupt-<ts> → 删除；表组经 generation
   * 失效，下次 open 时在全新文件上重建各自表结构。
   */
  async recoverCorrupt(reason: unknown): Promise<void> {
    try {
      this.db?.close();
    } catch {
      // 忽略关闭失败。
    }
    this.db = null;
    this.generation++;
    const backup = `${this.filePath}.corrupt-${this.now()}`;
    await copyFile(this.filePath, backup).catch(() => undefined);
    await rm(this.filePath, { force: true }).catch(() => undefined);
    console.warn(
      `索引库损坏或版本不兼容，已备份重建：${(reason as Error)?.message ?? reason}`,
    );
  }

  close(): void {
    try {
      this.db?.close();
    } finally {
      this.db = null;
    }
  }
}
