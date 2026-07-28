# 文档写入路径与一致性不变量（R004）

本文档盘点当前所有正文写入路径、保存状态机与 generation 语义，并定义 R004 的数据一致性不变量。需求全文见 `docs/requirements/r004.md`；保存管线细节见 `editor-save-pipeline.md`。

## 一、当前写入路径

### 协调器路径（实时编辑，唯一受串行队列保护）

```text
Tiptap onUpdate → noteEdit()（generation+1）→ 800ms 防抖 enqueue
→ DocumentSaveCoordinator 串行队列
→ content.save → revision.add/pruneInterval → removeOrphans → recovery.clear → 发布 saved
```

### 历史直写点（R004 阶段 3 已全部迁移清零）

以下 8 处直写已全部收敛到应用服务，架构扫描（`src/test/architecture.test.ts`）以空白名单强制——新增直写立即失败：

| 位置 | 原调用 | 迁移后 |
| --- | --- | --- |
| `src/components/TemplateCenter.tsx` | `page.create` + `content.save` | `createDocumentWithContent` action（原子创建） |
| `src/components/AIDraftModal.tsx` | `page.create` + `content.save` | 同上 |
| `src/components/PageTreeSidebar.tsx` | `content.save`（Markdown 导入） | 同上 |
| `src/components/VersionPanel.tsx` | `revision.add` + `content.save` | `DocumentEditorController.restore`（协调器串行化，INV-06） |
| `src/components/MainArea.tsx` | `content.save`（空白副本） | `documentCommit.replaceContent` |

注：损坏正文的「尝试恢复」与「应用恢复缓冲」本就走协调器（`DocumentEditor` 的 restoreRequestId effect）。附件写入经 `editor.storage.attachmentRepository` 通道（`src/editor/attachment.ts`），为 R003 认可的注入方式。

## 二、保存状态机

```text
saved → dirty → saving → saved / error
```

- `noteEdit()` 发布 `dirty`；`enqueue` 入队；
- drain 取快照执行时发布 `saving`；
- 正文提交成功且快照仍是当前 generation → `saved`（携带 savedAt）；
- 正文提交失败 → `error`（保留 lastFailed，可 `retryLatest()`）。

R004 阶段 1 起，维护步骤（版本/附件清理/恢复缓冲）失败**不进入** `error` 态，只走 `onMaintenanceError` 诊断回调——正文已落盘，不能误报未保存。

## 三、generation 定义

- 每个文档一个协调器实例，实例内 `generation` 从 0 起；
- `noteEdit()` 使 `generation + 1`；`enqueue()` 以调用时刻的 generation 为快照盖章；
- 快照携带 `capturedAt`（`Date.now()`，R004 阶段 1 新增），用于保护快照产生后新建的附件；
- 「当前快照」判定：`!disposed && snapshot.generation === this.generation`，**每次 await 之后必须重查**，不得缓存布尔值。

## 四、数据一致性不变量

```text
INV-01：同一文档的正文写入必须串行。
INV-02：只有当前最新 generation 可以发布 saved。
INV-03：旧快照不能删除其产生之后（capturedAt 之后）新增的附件。
INV-04：页面与初始正文必须原子创建。
INV-05：任何正文写入完成后，搜索索引必须同步。
INV-06：恢复版本不能被旧的防抖保存覆盖。
INV-07：UI 组件不得直接调用 ContentRepository 写方法。
```

本批（阶段 0-2）落地 INV-01/02/03/05 与 INV-04 的仓储能力；INV-04 的全流程迁移、INV-06、INV-07 清零属阶段 3（后续批）。

## 五、本批验收条件

- 阶段 0 新增的后处理竞态测试全部转绿；
- 旧 generation 永不发布 saved；旧快照不删 `capturedAt` 之后的附件；
- 维护失败不污染正文保存状态，刷新后仍见最新正文；
- `retryLatest()` 空态显式拒绝；
- `DocumentWriteRepository.createWithContent()` 单事务原子创建，失败不留空文档；IndexedDB 与内存实现同契约；
- 正文提交经 `DocumentCommitService` 单点完成「落盘 + 搜索索引同步」；
- 组件直写点维持 8 处快照白名单，新增即架构测试失败。

## 六、非目标（本批不做）

- 阶段 3：8 处直写点迁移、版本恢复串行化；
- 阶段 4：AppState 拆解、`useApp()` 淘汰；
- 阶段 5：IndexedDB v4、`contents/pageTags` 工作区索引；
- 阶段 6-7：图片附件化、存储配额、多标签页、CI 门禁。
