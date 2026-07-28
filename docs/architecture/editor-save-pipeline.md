# 编辑器保存管线

## 组件与职责

```text
Tiptap onUpdate
  ↓ DocumentEditor（装配层：监听更新、生成快照、展示状态）
  ↓ noteEdit() / 800ms 防抖 enqueue()
DocumentSaveCoordinator（application 层：串行队列 + 代次管理）
  ↓ DocumentContentCommitter（DocumentCommitService：落盘 + 搜索索引同步）
contentRepository.save → revisionRepository.add/prune → attachmentRepository.removeOrphans
```

`DocumentEditor` 只做编辑器装配与快照提交，持久化流程全部在 `DocumentSaveCoordinator`（`src/application/services/SaveCoordinator.ts`）。每个文档一个协调器实例，文档切换时旧实例排空后销毁。

## 核心规则（R003 阶段 1 + R004 阶段 1）

1. 每次编辑 `generation + 1`（`noteEdit`）；快照入队时盖章 `generation` 与 `capturedAt`；
2. 同一文档所有保存**串行**执行（`running` 链，永不并发）；
3. 队列中只保留最新尚未执行的快照（新快照覆盖 pending）；
4. 旧 generation 保存完成后**不发布 saved**——`isCurrent()` 在每个 await 之后重查，不缓存布尔值（R004：正文落盘后的维护窗口同样受保护）；
5. 维护任务（间隔自动版本、版本裁剪、孤儿附件清理、恢复缓冲清理）只对当前 generation 执行；附件清理只删快照 `capturedAt` 之前已存在的孤儿（`createdBeforeOrAt`，INV-03）；
6. **正文提交失败**才进入 error 态并保留快照，`retryLatest()` 重试（空状态显式拒绝）；**维护失败**不影响正文保存状态，经 `onMaintenanceError` 上报开发诊断；
7. `flush()` 在队列排空后 resolve；`dispose()` 排空后拒绝后续 enqueue。

一次保存的执行顺序：`committer.commit`（content.save + 搜索索引增量更新，INV-05 单点）→ 兑现 enqueue 等待者 → 非当前代次即止 → 维护任务（间隔版本（5 分钟节流、去重、上限 100）→ 附件清理 → 恢复缓冲清除，逐步重查 isCurrent）→ 发布 saved。

## 防抖与 flush

- 800ms 防抖（`useDebouncedCallback`）：快照参数自带编辑发生时的 pageId——即使 flush 发生在切换文档后，也会路由到旧文档的协调器，绝不写入新文档。
- 切换文档：先 flush 防抖（提交挂起快照），再 `dispose()` 旧协调器（排空队列后销毁）。
- beforeunload 保留监听，但**不保证** IndexedDB 异步写入完成——兜底是恢复缓冲。

## 恢复缓冲（R003 §1.4）

每次 enqueue 把快照写入 `localStorage["pending-document-recovery:{pageId}"]`（正文 JSON + generation + 时间戳，不写附件 Blob）；保存成功按代次清除。加载文档时若恢复缓冲比 IndexedDB 正文更新，显示恢复提示条：恢复（作为 initialContent 并立即保存一次）或丢弃。读取时正文 JSON 经白名单校验，坏数据直接清除。

## 保存状态机

`saved → dirty → saving → saved / error`，由协调器经 `onStateChange` 发布，顶栏 `SaveStateIndicator` 展示，error 态提供重试（`retryLatest`）。

## 相关测试

- 竞态基线：保存乱序（`SaveConcurrency.test.tsx`）、文档切换挂起保存（`SaveOnDocumentSwitch.test.tsx`）、附件清理竞态（`SaveAttachmentRace.test.tsx`）、保存后半程竞态（`SavePostCommitRace.test.tsx`，R004）；
- 协调器单测：串行、latest-wins、旧代次不发布 saved、维护挂起窗口重查、附件清理时间边界、维护失败分流、空 retryLatest 拒绝、失败重试、flush、恢复缓冲（`SaveCoordinator.test.ts`）；
- 状态机与自动版本集成：`SaveState.test.tsx`；
- 附件清理时间边界（仓储层）：`revisions-attachments.test.ts`。
