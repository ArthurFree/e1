# 版本历史（Revision History，R012）

本地版本历史的架构事实。需求与实施记录见
`docs/requirements/R012-desktop-revision-history.md`（由
`R011.1-closeout-and-R012-desktop-revision-history.md` Part B 拆出）。

**当前实施状态：Stage 0（语义与契约冻结 + RevisionRepository summary + lazy get
接口演进）、Stage 1（Main 侧不可变存储 `electron/main/revisions/`：
DesktopRevisionStore 原子快照 + DesktopRevisionIdentity 系列身份 +
DesktopRevisionRetention 裁剪）、Stage 2（revision IPC 七通道 + Renderer
真实 `DesktopRevisionRepository`，add 忽略传入 contentJson、由 Main 重读
磁盘 capture）、Stage 3（自动/手动 capture 编排）、Stage 4（Safe
Restore）、Stage 5（VersionPanel + Diff）与 Stage 6（文件生命周期集成：
R011 文件操作成功后 revision.relocate 同步 series 路径、purge 后
purgeSeries 清理；operation matrix 的 `revision.read/write` 已翻 true）
已落地。** 本文描述已冻结的目标设计与「现在已是什么」的边界。

## 核心不变量

- **REV-01：Revision 是正文历史，不是文件树/元数据历史。** 恢复只恢复
  Document Body；不恢复 physical filename、relative path、workspace/group、
  title、tags、stable id、created、aliases 与未知 Frontmatter 字段。
- **REV-02：Desktop 权威快照是 Raw Markdown Body。** 关系链是
  `Raw Markdown Body Snapshot → parse → Tiptap JSON / text preview → UI`；
  Tiptap JSON、textSnapshot、SQLite 行都不能作为 Desktop 历史的唯一真相。
  Desktop restore 不走「历史 JSON → MarkdownCodec.serialize → 写回」，
  避免重新格式化历史 Markdown。
- **REV-03：恢复正文时保留当前 Frontmatter。** id/title/tags/created/aliases/
  extra 保持当前值，`updated` 推进到恢复时间，physical path 不变。
- **REV-04：Revision History 不是派生数据。** SearchIndex/LinkIndex 可 rebuild，
  revision 快照不可 rebuild，因此不能只存在 SQLite。

## 存储结构（Desktop，Stage 1 已落地）

```text
<Vault>/.e1/revisions/
└── series/
    └── <seriesId>/
        ├── series.json            # RevisionSeriesManifest
        └── revisions/
            └── <revisionId>/
                ├── manifest.json  # DesktopRevisionManifest
                └── body.md        # raw Markdown body（不含 Frontmatter）
```

- 存储在 Vault 内（与 `.e1/trash` / `.e1/operations` 一致）：生命周期随 Vault、
  不依赖 userData、搬家时历史随行；Portable Export 默认排除 revision。
- 清单形状冻结在 `shared/revisions/types.ts`（`RevisionSeriesManifest` /
  `DesktopRevisionManifest`，均 `version: 1`）。revision manifest 记录
  `reason`、`relativePathAtCapture`、`sourceVersionToken`、`bodySha256`、
  `bodyBytes`、`lineEnding`、`textPreview`。
- `body.md` 由 `shared/revisions/rawMarkdownBody.ts` 的
  `splitRawMarkdownBody` 从整篇 Markdown 切出：边界判定复用
  `frontmatterBodyStartOffset`（BOM/CRLF 感知），body 是原串子串，
  **不做行尾归一化**（source-preserving，与 R011.1 R11C-06 同口径）。
  SHA-256 不在 shared/ 计算——Main 侧复用
  `electron/main/filesystem/AtomicFileWriter.ts` 的 `sha256Token`。

## Series Identity

- **有 stable id**：`stableNoteId` 固定 series（`sn_<stableNoteId>` 确定性派生），
  rename/move 后历史不变；
  R011 文件操作只更新 `series.json` 的 `currentRelativePath`，快照本身不移动。
- **path-only 文档**：创建随机 `seriesId`（`sp_<ulid>`），`series.json` 记录当前路径；
  E1 内部 rename/move 同步更新该路径。外部程序移动且无 stable id 时
  **不猜测身份**（v1 边界；adoption/portability 增强属 R014 方向）。

Stage 1 实现位于 `electron/main/revisions/DesktopRevisionIdentity.ts`
（resolveSeries / relocateSeries / relocateSeriesPrefix；series.json 经
临时文件 + rename 原子写）。形态不适合做目录名的 stable id 退化为
path-only 处理（不把任意字符串带上文件系统）。

## Snapshot 原子创建与去重

- 快照是不可变用户数据：先写 `<revisionId>.tmp-<random>/`（manifest + body），
  全部写完后 `rename(tempDir, revisionDir)` 原子就位；中断残留的 temp dir
  启动时（Store 构造后首次使用）清理。
- 去重依据 raw Markdown body 的 SHA-256：最新快照 `bodySha256` 与当前 body
  相同则 `add()` 返回 `null`（不重复落盘）。

Stage 1 实现位于 `electron/main/revisions/DesktopRevisionStore.ts`：
capture 重读当前 Markdown 后切 body 落盘（`manifest.sourceVersionToken`
记录调用方 attest 的保存版本令牌）；list 按 createdAt 倒序、单条
corrupt/unknown-version manifest 只进 degraded 列表跳过；revisionId 为
单调 ULID（同毫秒并列时保证次序确定）。

## Retention

沿用既有策略：interval 版本间隔 5 分钟
（`INTERVAL_REVISION_MS`）、数量上限 100（`INTERVAL_REVISION_KEEP`）、
总字节预算 5 MiB（`INTERVAL_REVISION_MAX_BYTES`）；最新 interval 版本恒保留
（`selectRevisionsToPrune` 的确定性规则）。自动裁剪只处理 `interval`，
`manual` / `before-restore` 永不自动删除。

**单一实现位置（Stage 1 起）**：常量与 `selectRevisionsToPrune` 已上移到
`shared/revisions/retention.ts`（electron 不得 import src，见
`.dependency-cruiser.js` 的 electron-no-src）；`src/domain/revisions.ts`
re-export 保持 Web 侧既有调用点不变，Desktop Main 侧
（`electron/main/revisions/DesktopRevisionRetention.ts`）直接引用 shared。

## Trash / Purge 语义

- Trash → revision 保留；Restore → revision 继续属于同一文档；
  Purge → 正文永久删除成功后 purge 对应 revision series。
- 外部（Finder/Git/VS Code）删除 Markdown 时**不自动删除** `.e1/revisions`；
  文件稍后带相同 stable id 回来时历史可重新关联。

## Diff 语义

Diff 以 **Markdown body source** 为准：行级 diff（added / removed /
unchanged-context），「历史版本 vs 当前正文」为必须项；不做富文本 DOM
semantic diff。`revision A vs revision B` 是增强项，不是 v1 blocker。

## RevisionRepository：summary + lazy get（Stage 0 已落地）

`src/domain/repositories.ts` 的 `RevisionRepository` 已从「全量
DocumentRevision 列表」演进为 summary + lazy get：

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
  add(
    pageId,
    contentJson,
    textSnapshot,
    reason,
  ): Promise<RevisionSummary | null>;
  pruneInterval(pageId, keep, maxBytes?): Promise<void>;
}
```

- **理由**：打开版本面板只调 `listRevisions`（摘要），避免一次读取并解析
  上百个完整版本；选中版本再 `getRevision` 取完整内容（VersionPanel 的预览
  与恢复已按此接线）。`bytes`/`textPreview` 字段名跨平台同名，为 Desktop 的
  `bodyBytes`/raw body 摘要预留，语义差异在 `src/domain/types.ts` 注释注明。
- Web IndexedDB 与内存实现同步适配（摘要映射 + 去重经 lazy get 取最新完整
  版本比对，`pruneInterval` 直接以摘要 `bytes` 计量），**Web 产品语义不变**；
  Desktop 的真实实现 `DesktopRevisionRepository` 于 Stage 2 落地（Stage 0 时
  为 no-op stub），operation matrix 的 `revision.read/write` 于 Stage 6
  测绿后翻转（原为 `false`）。
- textPreview 截断口径统一为
  `shared/revisions/rawMarkdownBody.ts` 的 `REVISION_TEXT_PREVIEW_MAX_CHARS`
  （200 字符），Web 摘要与 Desktop manifest 共用。

## 与保存管线的关系

保存顺序不变（`editor-save-pipeline.md`）：content commit → `revision.add`
→ `revision.pruneInterval` → 附件清理 → 恢复缓冲清理。revision 维护失败
只经 `onMaintenanceError` 上报，不污染正文保存状态。Desktop 落地后
`revision.add()` 的权威快照不以传入 `contentJson` 为准，而是保存成功后由
Main 重读当前 Markdown 并 capture raw body（REV-02）。

## IPC 通道与 DesktopRevisionRepository（Stage 2 已落地）

revision 组七通道（`shared/ipc/contracts.ts` + `shared/ipc/schemas.ts` +
`electron/main/ipc/revisions.ts`）：

| 通道 | 读写 | 语义 |
| ---- | ---- | ---- |
| `revision.list` | 只读（transient 允许） | 按文档身份列出摘要；损坏/未知版本 manifest 进 `degraded` 列表 |
| `revision.get` | 只读（transient 允许） | 单条完整快照；不存在/损坏返回 `null` |
| `revision.capture` | 写 | Main 重读磁盘当前 Markdown 捕获 raw body（Renderer 不传正文） |
| `revision.restore` | 写 | Safe Restore（见下节） |
| `revision.prune` | 写 | 只裁剪 interval 快照 |
| `revision.relocate` | 写 | R011 rename/move 后同步 series 当前路径（含前缀批量） |
| `revision.purgeSeries` | 写 | 文档永久删除后物理清理 series |

安全边界（§44 口径）：请求只允许 vaultId + 身份字段（relativePath /
stableNoteId? / seriesId?）+ revisionId + reason + expectedVersionToken +
keep/maxBytes；absolutePath 在 schema 层拒绝，vault 根由 Main 侧
`resolveVaultRoot` 解析；写通道 transient 仅预览拒写（VAULT_READ_ONLY，与
note 组同口径）；日志不含正文。handler 永不 throw，统一 IpcResult 信封。

Renderer 侧 `src/platform/desktop/DesktopRevisionRepository.ts` 实现
`RevisionRepository`（替换原 no-op stub，已删除）：身份翻译链
`pageId → DesktopVaultScanCache.findDocument → {vaultId, relativePath,
stableNoteId} → revision IPC`；找不到文档时按 stub 语义降级（listByPage → []、
get → undefined、add → null、pruneInterval → no-op），不 throw；IPC 错误按
`DesktopIpcError.code` 映射为 DomainError。`get` 返回的 DocumentRevision
`contentJson` 恒为 `null`、`textSnapshot` 即 raw Markdown body（恢复不走
contentJson，见 Safe Restore）。

## Capture 编排（Stage 3 已落地）

- **自动版本**：保存成功 + 距上个 interval ≥ 5 分钟 → interval snapshot；
  失败只进 maintenance warning，正文仍算 saved。
- **手动版本**：「创建版本」→ flush pending save → 保存成功 → manual
  snapshot；flush 发生 conflict / lossy / IO error 时不创建与编辑器状态不一致
  的手动版本，创建失败有明确错误提示。
- capture 在仓储层无条件执行；operation matrix 的 `revision.read/write`
  只门控 UI 入口（Stage 6 翻 true）。

## Safe Restore（Stage 4 已落地）

平台无关协调层 `src/application/services/RevisionRestoreCoordinator.ts`，双端
均装配 `AppServices.revisionRestore`，UI 不判断平台（DUAL-01）：

- **协调器编排（双端共享）**：`revisions.get` 取目标版本 → `port.validate?`
  目标校验（损坏版本不产生快照也不进编辑器）→ before-restore 快照
  （`revisions.add`）→ `port.restore`。before-restore 已创建但 restore 随后
  失败时，允许保留该安全快照；恢复前由调用方 flush pending autosave
  （失败/conflict 不进入协调器）。
- **JsonRevisionRestorePort（Web/内存）**：历史 contentJson 经白名单校验后
  由调用方 commit 闭包（保存协调器串行提交）落盘，语义与 R004 INV-06 一致。
- **DesktopRevisionRestoreService（Desktop）**：`revision.restore` IPC——Main
  复核磁盘版本令牌（不等 → DOCUMENT_CONFLICT，不写任何字节）→ 读当前
  Frontmatter → 取历史 raw body → 保留当前 Frontmatter（仅 `updated` 推进）
  拼回 → AtomicFileWriter 落盘（BOM 跟随磁盘现状，登记 SelfWriteRegistry
  抑制 watcher 回声）。IPC 成功后 Renderer 收口：SourceCache 推进新令牌
  （`updatedAt` 同步）→ DocumentVersionChannel 发布（打开中的保存协调器采纳
  新令牌，旧 autosave 不覆盖 restore）→ LinkIndex/SearchIndex 显式 reconcile
  （不依赖 watcher；派生索引失败仅降级可 rebuild，不回滚正文）。返回
  `reloadedExternally=true`，调用方重新读盘重建编辑器。

## VersionPanel 与 Diff 数据源（Stage 5 已落地）

`src/components/VersionPanel.tsx`：summary 列表（时间 / 自动·手动·恢复前 /
摘要 / 大小）+ 创建版本 + lazy preview（选中再 `revision.get`）+ 恢复二次确认，
覆盖 loading / empty / degraded / error 状态；打开面板只调 `revision.list`。

Diff 行级计算在 UI 侧 `src/components/lineDiff.ts`（`computeLineDiff`），
`src/components/RevisionDiff.tsx` 渲染 added / removed / unchanged-context。
对比数据源经 `RevisionRestoreCoordinator.diffWithCurrent`：historical = 目标
版本 textSnapshot（Desktop 即 raw Markdown body）；current =
`port.readCurrentSource`（Desktop 读磁盘当前 raw body 并剥离 Frontmatter，与
历史快照同口径），未实现或读取失败时回退编辑器 textSnapshot。
