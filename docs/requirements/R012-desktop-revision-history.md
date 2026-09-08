# R012 Desktop Revision History

> 版本：1.0
> 状态：全部完成（Stage 0–7；E2E/packaged/性能/远端 CI 全绿，run 34201541622）
> 更新时间：2026-09-08
> 目标平台：macOS Desktop
> 前置需求：R006、R007、R008、R010、R011、R011.1
> 后续需求：R013 macOS Signing & Trust

---

## 1. 文档目的

在 Desktop Markdown source-of-truth 架构下落地真实本地版本历史。本文档由
`R011.1-closeout-and-R012-desktop-revision-history.md` 的 Part B（原 §13–§50）拆出；
内容已按实施后的真实状态修正（原规划文档保留为历史快照）。

R012 的任务是让 Desktop 拥有真实版本历史，而不是从零重做 Web 版本系统：Web 端
既有领域语义（RevisionRepository / DocumentRevision / VersionPanel /
DocumentSaveCoordinator 维护任务 / interval / manual / before-restore）全部复用。

## 2. 基线（实施前）

实施前项目已存在 Web 版本历史的领域语义与策略：

```text
INTERVAL_REVISION_MS = 5 * 60 * 1000
INTERVAL_REVISION_KEEP = 100
INTERVAL_REVISION_MAX_BYTES = 5 * 1024 * 1024
```

Desktop 侧则是 no-op stub（listByPage → []、add → null、pruneInterval → no-op），
operation matrix 的 `revision.read/write` 为 false。R012 已将其替换为真实实现并翻转开关。

## 3. 核心不变量（已冻结）

### REV-01：Revision 是正文历史，不是文件树 / 元数据历史

恢复只恢复 Document Body；不恢复 physical filename、relative path、
workspace/group、title、tags、stable id、created、aliases 与未知 Frontmatter 字段。

### REV-02：Desktop 权威快照是 Raw Markdown Body

Tiptap JSON、textSnapshot、SQLite 行都不能作为 Desktop 历史的唯一真相：

```text
Raw Markdown Body Snapshot
        ↓ parse
Tiptap JSON / text preview
        ↓
UI
```

Desktop restore 不走「历史 JSON → MarkdownCodec.serialize → 写回」，避免重新格式化
历史 Markdown。

### REV-03：恢复正文时保留当前 Frontmatter

恢复后 id/title/tags/created/aliases/extra 保持当前值，`updated` 推进到恢复时间，
physical path 不变。

### REV-04：Revision History 不是派生数据

SearchIndex / LinkIndex 可 rebuild；revision 快照不可 rebuild，因此不能只存在
SQLite。

## 4. 存储位置与结构（Stage 1 已落地）

存储在 `<Vault>/.e1/revisions/`（与 `.e1/trash` / `.e1/operations` 一致）：生命周期
随 Vault、不依赖 userData、Vault 搬家时历史随行；Portable Export 默认排除 revision。

```text
.e1/revisions/
└── series/
    └── <seriesId>/
        ├── series.json            # RevisionSeriesManifest
        └── revisions/
            └── <revisionId>/
                ├── manifest.json  # DesktopRevisionManifest
                └── body.md        # raw Markdown body（不含 Frontmatter）
```

清单形状冻结在 `shared/revisions/types.ts`（`RevisionSeriesManifest` /
`DesktopRevisionManifest`，均 `version: 1`）。revision manifest 记录 `reason`、
`relativePathAtCapture`、`sourceVersionToken`、`bodySha256`、`bodyBytes`、
`lineEnding`、`textPreview`。`body.md` 由 `shared/revisions/rawMarkdownBody.ts` 的
`splitRawMarkdownBody` 切出（BOM/CRLF 感知，body 是原串子串，不做行尾归一化）。

## 5. Revision Identity（Stage 1 已落地）

- **有 stable id**：`stableNoteId` 固定 series（`sn_<stableNoteId>` 确定性派生），
  文件 rename/move 后历史不变。
- **path-only 文档**：创建随机 `seriesId`（`sp_<ulid>`），`series.json` 记录当前路径；
  E1 内部 rename/move 同步更新该路径。外部程序移动且无 stable id 时不猜测身份
  （v1 边界；adoption/portability 增强属 R014 方向）。形态不适合做目录名的 stable id
  退化为 path-only 处理。

实现位于 `electron/main/revisions/DesktopRevisionIdentity.ts`（resolveSeries /
relocateSeries / relocateSeriesPrefix；series.json 经临时文件 + rename 原子写）。

## 6. Snapshot 原子创建与去重（Stage 1 已落地）

- 快照是不可变用户数据：先写 `<revisionId>.tmp-<random>/`（manifest + body），全部
  写完后 `rename(tempDir, revisionDir)` 原子就位；中断残留的 temp dir 启动时清理。
- 去重依据 raw Markdown body 的 SHA-256：最新快照 `bodySha256` 与当前 body 相同则
  `add()` 返回 `null`（不重复落盘）。
- 单个损坏/未知版本 manifest 只进 degraded 列表跳过，不拖垮 Vault 打开；
  revisionId 为单调 ULID（同毫秒并列时保证次序确定）。

实现位于 `electron/main/revisions/DesktopRevisionStore.ts`。

## 7. RevisionRepository：summary + lazy get（Stage 0 已落地）

`src/domain/repositories.ts` 的 `RevisionRepository` 已从「全量 DocumentRevision
列表」演进为 summary + lazy get：

```ts
interface RevisionSummary {
  id: string;
  pageId: string;
  createdAt: number;
  reason: RevisionReason;
  bytes: number; // Web：contentJson 序列化字节；Desktop：body.md 字节
  textPreview: string; // Web：textSnapshot 截断；Desktop：raw body 轻量摘要
}

interface RevisionRepository {
  listByPage(pageId): Promise<RevisionSummary[]>;
  get(pageId, revisionId): Promise<DocumentRevision | undefined>;
  add(pageId, contentJson, textSnapshot, reason): Promise<RevisionSummary | null>;
  pruneInterval(pageId, keep, maxBytes?): Promise<void>;
}
```

打开版本面板只调 `listByPage`（摘要），避免一次读取并解析上百个完整版本；选中版本
再 `get` 取完整内容。Web IndexedDB 与内存实现同步适配（摘要映射 + 去重经 lazy get
取最新完整版本比对），**Web 产品语义不变**。textPreview 截断口径统一为
`shared/revisions/rawMarkdownBody.ts` 的 `REVISION_TEXT_PREVIEW_MAX_CHARS`（200 字符）。

## 8. Desktop Adapter 与 IPC（Stage 2 已落地）

Renderer 侧真实实现 `src/platform/desktop/DesktopRevisionRepository.ts`（替换原
no-op stub），身份翻译链：

```text
pageId
↓ DesktopVaultScanCache.findDocument(pageId)
vaultId + relativePath + stableNoteId
↓
revision IPC
```

找不到文档时按 stub 语义降级（listByPage → []、get → undefined、add → null、
pruneInterval → no-op），不 throw。`add()` 忽略传入 contentJson，由 Main 重读磁盘
capture（REV-02）。

IPC 七通道已冻结（`shared/ipc/contracts.ts` + `electron/main/ipc/revisions.ts`）：

```text
revision.list        只读，transient 允许
revision.get         只读，transient 允许；不存在/损坏返回 null
revision.capture     写；Main 重读磁盘当前 Markdown 捕获 raw body
revision.restore     写；乐观锁复核 + Frontmatter 保留合并 + 原子写
revision.prune       写；只裁剪 interval
revision.relocate    写；R011 rename/move 后同步 series 路径元数据
revision.purgeSeries 写；文档永久删除后物理清理历史
```

安全边界：Renderer 不传 fs/path/absolutePath（schema 层拒绝）；写通道 transient
仅预览拒写（VAULT_READ_ONLY）；Main 侧 schema validate → resolveVaultRoot →
PathGuard → expectedVersion revalidate；任何日志不含正文。

## 9. Capture 与 SaveCoordinator（Stage 3 已落地）

保存顺序不变（见 `docs/architecture/editor-save-pipeline.md`）：

```text
content commit → revision.add → revision.pruneInterval → 附件清理 → 恢复缓冲清理
```

Desktop `revision.add()` 的权威快照不以传入 `contentJson` 为准，而是保存成功后由
Main 重读当前 Markdown 并 capture raw body（REV-02）。capture 在仓储层无条件执行，
operation flags 只门控 UI 入口。

- **自动版本**：保存成功 + 距上个 interval ≥ 5 min → interval snapshot。自动
  snapshot 失败只经 `onMaintenanceError` 上报，正文仍算 saved，不污染保存状态。
- **手动版本**：用户点击「创建版本」→ flush pending save → 保存成功 → manual
  snapshot。flush 发生 conflict / lossy / IO error 时不创建与编辑器状态不一致的
  手动版本；创建失败有明确错误提示。

## 10. Safe Restore（Stage 4 已落地）

平台无关协调层 `src/application/services/RevisionRestoreCoordinator.ts`
（`RevisionRestorePort` 接口，UI 不判断平台，双端均装配 `AppServices.revisionRestore`）：

- **编排（双端共享）**：取目标版本（get）→ 目标校验（可选 `port.validate`，损坏版本
  不产生快照也不进编辑器）→ before-restore 快照（`revisions.add`，Web 存 JSON、
  Desktop 由 Main 重读磁盘 capture）→ `port.restore`（平台差异全部收口在 port 内）。
  before-restore 已创建但 restore 随后失败时，允许保留该安全快照。
- **JsonRevisionRestorePort（Web/内存）**：历史 contentJson 经白名单校验后由调用方
  commit 闭包（保存协调器串行提交）落盘，语义与 R004 INV-06 一致。
- **DesktopRevisionRestoreService（Desktop）**：`revision.restore` IPC——Main 复核
  磁盘版本令牌（DOCUMENT_CONFLICT 则不写任何字节）→ 读当前 Frontmatter → 取历史
  raw body → 保留当前 Frontmatter（仅 updated 推进）拼回 → AtomicFileWriter 落盘
  （BOM 跟随磁盘现状）。IPC 成功后 Renderer 侧收口：SourceCache 推进新令牌
  （updatedAt 同步）→ DocumentVersionChannel 发布（打开中的保存协调器采纳新令牌，
  旧 autosave 不覆盖 restore）→ LinkIndex/SearchIndex 显式 reconcile（不依赖
  watcher；派生索引失败仅降级，不回滚正文）。返回 `reloadedExternally=true`，由
  调用方重新读盘重建编辑器。

并发规则：restore 前必须 flush pending autosave（失败/conflict 不进入协调器）；
restore 必须乐观锁；外部编辑导致 token 变化 → DOCUMENT_CONFLICT；old autosave
不得覆盖 restore。

## 11. R011 文件操作与 Revision Series（Stage 6 已落地）

R011 reconcile 已扩展（`DesktopFileOperationService`）：

- Document rename/move → `revision.relocate`（stableNoteId 或 path-only 按
  fromRelativePath 定位）同步 series 当前路径；
- Group rename/move → `revision.relocate` 前缀批量搬迁。

历史 snapshot 本身不移动，只更新 series 路径元数据；relocate 失败仅告警降级，
不阻断已成功的文件操作。

## 12. Trash / Restore / Purge（Stage 6 已落地）

```text
Trash   → revision 保留
Restore → revision 继续属于同一文档
Purge   → 正文永久删除成功后 purge revision series
```

`DesktopPageRepository` 的 purge 链路已接通 `revision.purgeSeries`（purge 前先取
回收站条目身份；清理失败仅告警，历史按孤儿语义残留）。外部（Finder/Git/VS Code）
删除 Markdown 时不自动删除 `.e1/revisions`；文件稍后带相同 stable id 回来时历史可
重新关联。

## 13. Retention（Stage 0/1 已落地）

沿用既有策略：interval 版本间隔 5 分钟、数量上限 100、总字节预算 5 MiB；最新
interval 版本恒保留（`selectRevisionsToPrune` 确定性规则）。自动裁剪只处理
`interval`，`manual` / `before-restore` 永不自动删除。常量与 `selectRevisionsToPrune`
单一实现在 `shared/revisions/retention.ts`（`src/domain/revisions.ts` re-export
保持 Web 侧既有调用点不变）。

## 14. Diff（Stage 5 已落地）

Diff 以 **Markdown body source** 为准：行级 diff（added / removed /
unchanged-context，UI 侧 `src/components/lineDiff.ts` 的 `computeLineDiff`），
「历史版本 vs 当前正文」为必须项；不做富文本 DOM semantic diff。

对比数据源经 `RevisionRestoreCoordinator.diffWithCurrent`：historical = 目标版本
textSnapshot（Desktop 为 raw Markdown body）；current = `port.readCurrentSource`
（Desktop 读磁盘 raw body，与历史快照同口径），未实现或读取失败时回退编辑器
textSnapshot。`revision A vs revision B` 是增强项，未做（非 v1 blocker）。

## 15. VersionPanel（Stage 5 已落地）

复用并升级 `src/components/VersionPanel.tsx` + `src/components/RevisionDiff.tsx`：

```text
版本历史
├─ 创建版本（manual snapshot）
├─ summary 列表（时间 / 自动·手动·恢复前 / 文本摘要 / 大小）
├─ lazy preview（选中再 revision.get）
├─ 与当前版本比较（行级 diff）
└─ 恢复此版本（二次确认）
```

打开面板只调 `revision.list`，点击版本再 `revision.get`，避免一次解析全部快照；
覆盖 loading / empty / degraded / error 状态。UI 只依赖 AppServices + operation
gate，不判断平台（DUAL-01）。

## 16. Operation Gate（Stage 6 已翻转）

S2–S5 的 list/get/preview/capture/restore/retention 全部测绿后，`desktopOperations`
的 `revision.read/write` 已翻 true（`src/platform/desktop/desktopOperations.ts`，
`desktopOperations.test.ts` 锁定）。Web 全 true 不变。

## 17. 实施记录（Stage 0–7）

| Stage | 内容 | 状态 |
| ----- | ---- | ---- |
| 0 | 语义与契约冻结（REV-01~04 / identity / trash-purge / retention / diff）+ RevisionRepository summary + lazy get 演进 + raw body splitter | 完成 |
| 1 | Main 侧不可变存储 `electron/main/revisions/`（DesktopRevisionStore 原子快照 + DesktopRevisionIdentity + DesktopRevisionRetention） | 完成 |
| 2 | revision IPC 七通道 + Renderer 真实 `DesktopRevisionRepository` | 完成 |
| 3 | 自动/手动 capture 编排（interval 5min、manual/before-restore bypass、去重、维护失败不污染保存状态） | 完成 |
| 4 | Safe Restore（flush → before-restore → 乐观锁复核 → raw body 合并 → 原子写 → SourceCache/版本通道推进 → 双索引 reconcile） | 完成 |
| 5 | VersionPanel + Diff（summary lazy list / preview / manual create / 行级 diff / restore 确认 / degraded 状态） | 完成 |
| 6 | 文件生命周期集成（rename/move relocate、purge 后 purgeSeries）+ operation matrix `revision.read/write` 翻 true | 完成 |
| 7 | Scale / E2E / Packaged / Docs：G44–G56 与 P17–P20 全绿、性能达标、文档收口、远端 CI 六 job 全绿（run 34201541622） | 完成 |

## 18. Unit / Contract Test Matrix（已覆盖）

- Raw Snapshot：LF / CRLF / BOM、无 frontmatter / 有 frontmatter / 未知字段、
  中文 / emoji / 空格、空 / 大 body；
- Capture：首个 interval、5min 内不建、5min 后建、manual / before-restore、同 body
  去重、原子创建、disk full / permission denied；
- Retention：100 上限、5MiB 预算、最新保留、manual / before-restore 永不自动裁剪、
  最旧优先确定性；
- Restore：正文恢复、title/tags/id 保持、未知 frontmatter 保持、updated 推进、
  文件名/路径不变、expectedVersion 冲突、before-restore 已创建、旧 autosave 不覆盖、
  LinkIndex / SearchIndex 刷新；
- Lifecycle：rename/move 保历史、group rename/move 保历史、trash/restore 保历史、
  purge 删历史、外部删除留孤儿历史、stable-id 回归重新关联。

## 19. Desktop Golden E2E（G44–G56，已全绿 13/13）

```text
G44  自动保存后 interval revision 可读取
G45  手动创建版本 → 重启后仍存在
G46  VersionPanel lazy preview
G47  恢复正文 → current title/tags/id/path 不变
G48  before-restore 可再次恢复回去
G49  选中版本后外部编辑 → conflict，不覆盖
G50  Document rename/move → 历史仍属于同一 stable note
G51  Group rename/move → 子文档历史仍可访问
G52  Trash → Restore → 历史仍存在
G53  Purge → revision series 删除
G54  CRLF/source formatting restore 保持
G55  Link-rich 文档 restore → LinkIndex/backlink 正确
G56  restore 后全文搜索立即命中新正文
```

## 20. Packaged E2E（P17–P20，已全绿 4/4）

```text
P17 packaged capture + restart persistence
P18 packaged restore + before-restore
P19 packaged rename/move 后 revision identity 保持
P20 packaged .e1/revisions atomic store + retention
```

真实覆盖 asar / node:fs / AtomicFileWriter / PathGuard / safe restore /
SourceCache / LinkIndex / SearchIndex。

## 21. Performance（实测达标）

| 目标 | 阈值 | 实测 p95 |
| ---- | ---- | -------- |
| 100 revision summaries list | < 100ms | 6.6ms |
| 1 MiB capture | < 150ms | 32ms |
| 1 MiB get（preview 读取） | < 200ms | 3.3ms |

自动 capture 属维护任务，未造成可感知编辑冻结（wall-clock 基准
`electron/main/revisions/DesktopRevisionStore.perf-wallclock.test.ts`，不进 CI）。

## 22. Failure Model

- **自动 snapshot 失败**：正文 saved + revision maintenance warning；
- **手动 snapshot 失败**：明确提示创建版本失败；
- **Revision 损坏**：跳过该 revision + degraded warning；
- **Restore conflict**：DOCUMENT_CONFLICT + 不修改 Markdown；
- **Restore IO error**：AtomicFileWriter 保证原 Markdown 不被 truncate；
- **Index reconcile 失败**：正文 restore 已成功 + derived index degraded + 允许
  rebuild；不能只因 derived index 失败回滚已成功的 Markdown restore。

## 23. Security Boundary

Renderer 允许传：`vaultId`、pageId / noteKey、`relativePath`、`revisionId`、
`reason`、`expectedVersionToken`；不得传 `absolutePath` 与通用 fs 操作。

Revision 快照可能包含用户正文：不记录 raw body 到日志、不记录 telemetry 正文、
错误消息不拼完整 Markdown。允许的诊断字段：revisionId / reason / bodyBytes /
relativePath / errorCode。

## 24. R012 完成后的 Operation Matrix

```ts
revision: {
  read: true,
  write: true,
}
```

Desktop 文件生命周期在 Create / Rename / Move / Trash / Restore / Purge 之上增加
Edit / Snapshot / Diff / Restore Version。

## 25. Definition of Done

### Storage

- [x] Desktop revision 真实落盘（`.e1/revisions/series/<seriesId>/revisions/<revisionId>/`）；
- [x] raw Markdown body 是权威 snapshot（capture 由 Main 重读磁盘，REV-02）；
- [x] snapshot immutable + atomic create（temp dir + rename）；
- [x] 不依赖 SQLite 才能恢复（快照为独立文件，SQLite 仅存可重建索引）；
- [x] 相邻同 body 去重（SHA-256 比对，`add()` → null）。

### Semantics

- [x] interval 5min / 100 / 5MiB；
- [x] manual / before-restore 不自动裁剪；
- [x] restore 只恢复正文（REV-01）；
- [x] current Frontmatter 保持（REV-03）；
- [x] `updated` 正常推进。

### Restore Safety

- [x] restore 前 flush（失败/conflict 不进入协调器）；
- [x] before-restore snapshot（协调器统一创建）；
- [x] optimistic version revalidate（Main 复核磁盘令牌）；
- [x] conflict 不覆盖（DOCUMENT_CONFLICT 不写任何字节）；
- [x] old autosave 不覆盖 restore（SourceCache + DocumentVersionChannel 推进）；
- [x] AtomicFileWriter；
- [x] LinkIndex / SearchIndex reconcile（显式 upsert，失败仅降级）。

### Lifecycle

- [x] document/group rename/move history 不丢（revision.relocate）；
- [x] trash/restore history 不丢；
- [x] purge 删除 history（purgeSeries）；
- [x] external delete 不误删 history（孤儿 series 保留）。

### UI

- [x] VersionPanel Desktop 可用；
- [x] summary lazy list；
- [x] preview / manual create / diff / restore confirm；
- [x] corrupt/degraded state。

### Architecture

- [x] Renderer no fs/path/absolutePath（schema 层拒绝）；
- [x] UI no platform branch（AppServices + operation gate，DUAL-01）；
- [x] DesktopRevisionRepository 替换 no-op stub（原 stub 已删除）；
- [x] Markdown 仍是当前正文 source of truth（DUAL-04）；
- [x] Revision 明确属于不可重建用户数据（REV-04，独立于 SQLite）；
- [x] Web revision 无回归（Web/内存实现同步适配，产品语义不变）。

### Quality

- [x] unit / contract / component green（1738+ 全绿）；
- [x] G44–G56 green（13/13）；
- [x] P17–P20 real packaged green（4/4）；
- [x] typecheck / lint / deps:check green；
- [x] build:web / build:desktop green；
- [x] latest remote CI green（2026-09-08 run 34201541622 六 job 全绿）。

### Docs

- [x] `docs/requirements/R012-desktop-revision-history.md`（本文档）；
- [x] requirements README；
- [x] `docs/architecture/revision-history.md`；
- [x] document-write-path / runtime-boundaries；
- [x] file-operations lifecycle integration；
- [x] decisions / AGENTS。

## 26. 非目标

R012 v1 不做：

```text
Git replacement / Git history UI
云端 revision sync
多人协作版本
block-level history
rich-text semantic diff
workspace/folder snapshot
attachment binary versioning
automatic merge
Time Machine replacement
Windows/Linux Revision QA
revision A vs revision B diff
```

附件只保留正文中的引用，不复制附件二进制历史。历史版本引用的附件已被永久删除时，
preview 可以显示 missing asset，restore 不自动复活附件。

## 27. 必须避免的实现（已守住）

```text
Revision = SQLite row only           → 快照为 .e1/revisions/ 独立文件
Revision = Tiptap JSON only          → 权威快照是 raw Markdown body
Desktop restore = JSON → serialize   → revision.restore IPC 合并落盘
Restore 整篇旧 .md 覆盖 title/tags   → 保留当前 Frontmatter 只换 body
依赖 watcher 才更新 Link/Search      → 显式 reconcile
capture 失败 → 正文 save error       → 维护失败只上报 onMaintenanceError
```

## 28. 最终架构（已落地）

Capture：

```text
Editor
↓
DocumentSaveCoordinator
↓
DocumentCommitService
↓
DesktopMarkdownWriteService
↓
Markdown File
↓ success
DesktopRevisionRepository
↓
revision.capture IPC
↓
DesktopRevisionStore
↓
.e1/revisions/.../body.md
```

Restore：

```text
VersionPanel
↓
RevisionRestoreCoordinator
↓ flush SaveCoordinator
↓
before-restore capture
↓
revision.restore IPC
↓
current Frontmatter + historical raw body
↓
AtomicFileWriter
↓
new version token
↓
Renderer reload
↓
LinkIndex / SearchIndex reconcile
```

File Operations：

```text
R011 FileOperationService
↓ rename / move
RevisionSeries relocate metadata
```

## 29. 变更记录

| 版本 | 日期 | 变更 |
| ---- | ---- | ---- |
| 1.0 | 2026-09-08 | 从 `R011.1-closeout-and-R012-desktop-revision-history.md` Part B（原 §13–§50）拆出为独立需求文档；按实施完成状态修正全文（Stage 0–6 已落地，Stage 7 验收完成：G44–G56 / P17–P20 / 性能实测达标 / 远端 CI 全绿） |
