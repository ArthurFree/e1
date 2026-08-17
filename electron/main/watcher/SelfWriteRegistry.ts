/**
 * R007 阶段 3（DSK-02）：E1 自写登记与 watcher 回声抑制。
 *
 * note.save / note.patchMetadata / note.create / asset.import 成功后登记一条
 * 「这次写入是 E1 自己干的」记录；VaultWatcher 收到 chokidar 事件后在进
 * coalescer 之前查询本注册表，命中即抑制（消费），避免自动保存触发
 * Renderer 的 reload / 冲突误报（验收 6：不触发 reload loop）。
 *
 * 抑制语义：
 * - 无未过期记录 → 不抑制；
 * - 记录无 versionToken（asset 场景，Main 不算资源 hash）→ 直接抑制；
 * - 记录有 versionToken 且与事件时刻算出的当前文件 hash 相等 → 抑制；
 *   不等（外部程序在 E1 写后又改了文件）→ 不抑制、也不消费——记录仍可能
 *   匹配后续真正由本次写入产生的事件。
 * - 命中即消费（删除该条），同一记录的回声只吞一次。
 *
 * 记录有有效期（默认约 10 秒），惰性清理：仅在 record/shouldSuppress 被
 * 调用时顺带剔除过期项，不挂定时器。
 */

/** 自写记录默认有效期（ms）：覆盖 chokidar awaitWriteFinish + 防抖窗口。 */
export const SELF_WRITE_TTL_MS = 10_000;

export interface SelfWriteRecordInput {
  vaultId: string;
  relativePath: string;
  /** 写入后的磁盘 versionToken（sha256:<hex>）；asset 等无 token 场景省略。 */
  versionToken?: string | null;
}

interface SelfWriteEntry {
  versionToken: string | null;
  expiresAt: number;
}

export class SelfWriteRegistry {
  private readonly entries = new Map<string, SelfWriteEntry>();

  constructor(
    private readonly ttlMs: number = SELF_WRITE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** 登记一次 E1 自写（同 key 覆写旧记录）。 */
  record(input: SelfWriteRecordInput): void {
    this.prune();
    this.entries.set(keyOf(input.vaultId, input.relativePath), {
      versionToken: input.versionToken ?? null,
      expiresAt: this.now() + this.ttlMs,
    });
  }

  /**
   * 判断 watcher 事件是否为本进程自写回声。
   * currentToken：事件时刻读到的当前文件 sha256 token；文件已不存在传 null。
   * 命中后消费该条记录。
   */
  shouldSuppress(
    vaultId: string,
    relativePath: string,
    currentToken: string | null,
  ): boolean {
    const key = keyOf(vaultId, relativePath);
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return false;
    }
    // asset 等无 token 场景：有未过期记录即抑制。
    if (entry.versionToken === null) {
      this.entries.delete(key);
      return true;
    }
    // note 场景：内容 hash 与自写结果一致才是回声；不等则保留记录（可能是
    // 外部写入叠加在 E1 写之后，真正的事件尚未到达）。
    if (entry.versionToken === currentToken) {
      this.entries.delete(key);
      return true;
    }
    return false;
  }

  /** 当前未过期记录数（诊断/测试用）。 */
  get size(): number {
    this.prune();
    return this.entries.size;
  }

  /** 惰性清理过期记录。 */
  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

function keyOf(vaultId: string, relativePath: string): string {
  return `${vaultId} ${relativePath}`;
}
