/**
 * R011 Desktop File Operations v2 — 路径变更、源码级链接改写、journal 事务。
 *
 * 见 `docs/requirements/R011-desktop-file-operations-v2.md`。
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
 */
