/**
 * 恢复缓冲 port（R005 阶段 8 §8.1）：编辑器未落盘内容的最后一道兜底。
 *
 * beforeunload 无法保证 IndexedDB 异步写入完成，因此每次有编辑进入保存
 * 队列时，把最新正文快照写入恢复缓冲；保存成功后清除。应用加载文档时
 * 若发现恢复缓冲比已落盘正文更新，提示用户恢复。
 *
 * 平台实现：
 * - Web：src/platform/web/webRecoveryStore.ts（localStorage，key 格式与
 *   R003 起的数据结构保持一致，存量未保存缓冲平滑衔接）；
 * - 内存：src/infrastructure/memory/recoveryStore.ts（测试/可替换性证明）；
 * - Desktop（未来）：Electron userData/recovery。
 *
 * 安全约定：只写正文 JSON 与元数据，不写附件二进制，不写任何密钥；
 * 恢复缓冲与 IndexedDB 同属本地数据源，不扩大数据暴露面。
 */

/** 恢复缓冲记录：正文 JSON + 保存代次 + 写入时间。字段名沿用 R003 起的形状。 */
export interface RecoveryRecord {
  pageId: string;
  contentJson: unknown;
  generation: number;
  timestamp: number;
}

export interface RecoveryStore {
  /** 写入/覆盖某文档的恢复缓冲；存储不可用或超限时仅降级告警，不阻塞编辑。 */
  write(record: RecoveryRecord): Promise<void>;
  /** 读取恢复缓冲；数据损坏（含正文 JSON 未通过白名单校验）时删除并返回 null。 */
  read(pageId: string): Promise<RecoveryRecord | null>;
  /**
   * 保存成功后清除恢复缓冲。仅当缓冲内容的代次已被落盘
   * （≤ savedGeneration）时才删除，避免旧保存清掉更新的未落盘内容。
   */
  clear(pageId: string, savedGeneration: number): Promise<void>;
  /** 无条件丢弃某文档的恢复缓冲（用户选择「丢弃」或重新载入磁盘版本时）。 */
  discard(pageId: string): Promise<void>;
}
