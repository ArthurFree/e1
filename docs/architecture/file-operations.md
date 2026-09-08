/**
 * R011 Desktop File Operations v2 — 路径变更、源码级链接改写、journal 事务。
 * R011.1 收口：journal 升级 v2（逐跳持久化 + 崩溃恢复语义冻结）、链接改写改为 source-preserving。
 *
 * 见 `docs/requirements/R011-desktop-file-operations-v2.md`
 * 与 `docs/requirements/R011.1-closeout-and-R012-desktop-revision-history.md`。
 *
 * 核心链路：
 *
 * ```text
 * UI → FileOperationService.plan → FileOperationPreflightDialog
 *   → FileOperationService.execute → IPC fileOperation.execute
 *   → JournaledFileOperationEngine（backup → rewrite → rename → commit）
 *   → Source Cache / LinkIndex / SearchIndex 显式 reconcile
 * ```
 *
 * 约束：
 * - Markdown 是真相；LinkIndex 是派生数据；
 * - 只改写 `[text](href)` / `![alt](src)` 目的地；
 * - Renderer 不见 absolutePath；
 * - 操作开关在对应能力测绿后才翻 true；
 * - 应用内 move 成功后必须显式 reconcile，不能依赖被抑制的 watcher。
 * - R012 Stage 6 生命周期集成：文档/分组 rename/move 成功后
 *   revision.relocate 同步 revision series 当前路径（快照本身不移动，
 *   失败仅告警降级）；文档 purge 后 purgeSeries 清理历史。
 *
 * Journal v2（`shared/fileOperations/journal.ts`，version: 2）：
 * - 顶层不再有 from/toRelativePath，路径信息全部下沉到 `pathSteps`；
 * - 每个 document/group 路径变更独立成 step，逐 move 持久化：
 *   pending → intent（落盘）→ 执行 rename → applied（落盘）；
 *   回滚时 rollback-intent → rolled-back；任一步无法安全判定即 recovery-required；
 * - case-only rename 经临时 hop，`hopState` 四状态逐跳落盘：
 *   to-hop-intent → at-hop → to-target-intent → at-target（无 hop 时为 none）；
 * - `phase` 集合：prepared / rewriting / relocating / committed / rolling-back / recovery-required。
 *
 * 恢复判定（journal intent + 磁盘实际存在性四象限，普通 rename）：
 *
 * ```text
 * from exists + to missing  → rename 未发生，无需回滚
 * from missing + to exists  → rename 已发生，执行 to → from 回滚
 * from exists + to exists   → 无法安全判定，recovery-required
 * from missing + to missing → 无法安全判定，recovery-required
 * ```
 *
 * Journal 读取（`FileOperationJournal.readJournal` → `JournalReadResult`）：
 * - 显式四类：ok / missing / corrupt / unsupported-version；
 * - corrupt 与 unsupported-version 不再静默跳过，进入 FILE_OPERATION_RECOVERY_REQUIRED；
 * - execute 入口发现 pending/unreadable journal 即拒绝新操作；
 * - v1 journal 不迁移：读出即 unsupported-version（旧 journal 只在崩溃中断时残留，
 *   显式人工恢复优于隐式迁移）。
 *
 * Backup 命名：
 * - `backup/<sha256(relativePath) 前 16 位>/<basename>`，避免 `a/b.md → a__b.md` 式碰撞；
 * - 真实 originalRelativePath 只存在 manifest。
 *
 * Partial rollback：
 * - 任一路径回迁失败即 `phase = recovery-required`，journal 保留（只含相对路径的诊断信息）；
 * - 只有 confirmed committed 或 confirmed safely rolled back 才能删除 journal。
 *
 * Source-preserving 链接改写（`shared/links/rewriteMarkdownLinkDestinations.ts`）：
 * - 不做整文件 `\r\n → \n` 归一化，扫描与替换全部在原始串上进行；
 * - CRLF / UTF-8 BOM / 未命中字节逐字节保留（BOM 由 frontmatter trim() 天然兼容）；
 * - 只允许链接目的地字节发生变化。
 */
