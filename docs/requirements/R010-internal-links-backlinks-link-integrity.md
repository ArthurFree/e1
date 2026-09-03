# R010：内部链接、反向链接与链接完整性

英文：Internal Links, Backlinks & Link Integrity

- 当前版本：1.0
- 状态：已完成
- 最后更新：2026-08-31
- 来源：本文由 `R009-closeout-R010-macos-only-plan.md` §10–§28 抽出独立成文，内容保持一致；后续进度与偏差回写本文。

## 变更记录

| 版本 | 日期       | 说明                                                                                                                                                                                                                                                                                         |
| ---- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1  | 2026-08-31 | 独立成文；经用户确认全量实施 Stage 0–7，Desktop 优先、Web 端按 `AppServices.linkIndex` 可选字段存在性门控（沿用 `fullTextSearch` 先例，不加 RuntimeCapabilities 字段）                                                                                                                       |
| 1.0  | 2026-08-31 | Stage 0–7 全部完成：语义冻结（shared/links）、internalLink 编辑器、双提取器、LinkIndex 共库索引 + IPC 八通道、增量 Reconciliation、Backlinks/失效链接 UI、规模验收（10k rebuild 2.1–2.5s 达标）与 G21–G30 桌面 E2E 全绿；P10–P12 安装包 E2E 随 release 管线执行。全量 `npm run ci` 1526 例绿 |

## 阶段清单

- [x] Stage 0：链接语义冻结（2026-08-31）
- [x] Stage 1：Internal Link 编辑器（2026-08-31）
- [x] Stage 2：链接提取（2026-08-31）
- [x] Stage 3：派生链接索引（2026-08-31）
- [x] Stage 4：增量 Reconciliation（2026-08-31）
- [x] Stage 5：Backlinks UI（2026-08-31）
- [x] Stage 6：失效链接与重新定位（2026-08-31）
- [x] Stage 7：规模验收与 E2E（2026-08-31）

执行顺序：Stage 0 → 2 → 3 → 4（索引管线先行，从 Markdown link mark 提取，不依赖编辑器改造）；Stage 1 紧随其后；Stage 5 → 6 → 7 收尾。

---

# 1. 为什么现在优先做 R010

当前 E1 已经拥有：

```text
Markdown Editor
Local Vault
Stable Note Identity
Watcher
SQLite Search
Attachments
Trash
Full-text Search
Packaging
Auto Update
```

但知识之间仍然主要是独立 Markdown 文件。

下一阶段应该让 E1 从：

```text
Markdown Editor
```

升级为：

```text
Linked Knowledge Base
```

因此 R010 的产品价值明显高于继续扩展 Desktop 基础设施、Windows 平台、Search 微优化、Group Move 或 Revision History。

---

# 2. 当前已经存在的基础

编辑器已有：

```text
@ Mention
```

当前流程：

```text
输入 @
    ↓
搜索当前 Workspace Document
    ↓
选择页面
    ↓
插入 Mention Node
```

数据结构类似：

```ts
{
  type: "mention",
  attrs: {
    id: page.id,
    label: page.title
  }
}
```

这说明页面选择 UI、页面搜索、目标 pageId 和编辑器节点已经存在。

R010 不需要从零构建，需要做的是：

```text
Mention
    ↓
Internal Knowledge Link
```

并围绕它建立：

```text
Backlinks
Outgoing Links
Broken Links
Link Index
```

---

# 3. R010 核心原则

## LINK-01 Markdown 保持 Source of Truth

磁盘仍然保存普通 Markdown：

```markdown
[React Fiber](../React/React-Fiber.md)
```

不要默认保存：

```text
e1://page/xxx
```

之类 E1 私有协议。

E1 Vault 必须继续兼容 VS Code、Typora、Obsidian、GitHub、Git 和普通文本工具。

## LINK-02 Runtime Identity 使用 Stable Page ID

磁盘链接通过 relative path 表达，运行时解析后使用 stable page id 表达目标身份。

```text
Disk Identity
=
relative Markdown path

Runtime Identity
=
stable page id
```

两者明确分离。

## LINK-03 Link Index 是 Derived Data

保持 R008 Search 的原则：

```text
Markdown = Truth
Link Index = Derived Data
```

Link Index 可以删除、可以重建；损坏不能影响 Markdown，更新失败不能阻止文档保存。

## LINK-04 不根据 Title 定位

禁止：

```text
title
→ page
```

作为链接身份。

例如：

```text
项目A/README.md
项目B/README.md
```

标题可能完全一样。

内部链接必须最终由：

```text
relative path
→ target file
→ stable note id
```

解析。

---

# 4. R010 架构

推荐：

```text
Editor / Markdown
      ↓
LinkExtractor
      ↓
LinkResolver
      ↓
LinkIndexPort
      ↓
DesktopLinkIndex
      ↓
DesktopLinkDatabase
      ↓
SQLite
```

UI：

```text
Document
   ├─ Outgoing Links
   └─ Backlinks
```

Watcher：

```text
VaultWatcher
   ↓
ExternalVaultChangeService
   ↓
LinkIndexReconciler
   ↓
LinkIndexPort
```

---

# 5. 数据模型

建议：

```ts
interface DocumentLink {
  sourcePageId: string;

  href: string;
  label: string;

  kind: "internal" | "external" | "asset" | "anchor";

  targetPageId: string | null;
  targetRelativePath: string | null;
  fragment: string | null;

  broken: boolean;
  sourceVersion: string;
}
```

Backlink：

```ts
interface Backlink {
  sourcePageId: string;
  targetPageId: string;

  sourceTitle: string;
  snippet: string | null;
  href: string;
}
```

---

# 6. LinkIndexPort

推荐：

```ts
interface LinkIndexPort {
  prepareWorkspace(workspaceId: string): Promise<void>;

  replaceOutgoing(pageId: string, links: DocumentLink[]): Promise<void>;

  getOutgoing(pageId: string): Promise<DocumentLink[]>;

  getBacklinks(pageId: string): Promise<Backlink[]>;

  getBrokenLinks(workspaceId: string): Promise<DocumentLink[]>;

  rebuild(workspaceId: string): Promise<void>;
}
```

不要让 components、application、domain 直接 import SQL / SQLite。

---

# 7. SQLite Schema 建议

可以与 Search DB 使用同一个物理 SQLite 文件，也可以独立，但逻辑上必须保持 `SearchIndex` 和 `LinkIndex` 两个 Port / Adapter。

推荐 schema：

```sql
CREATE TABLE links (
  source_page_id TEXT NOT NULL,
  target_page_id TEXT,
  target_path TEXT,
  href TEXT NOT NULL,
  label TEXT NOT NULL,
  fragment TEXT,
  link_kind TEXT NOT NULL,
  broken INTEGER NOT NULL,
  source_version TEXT NOT NULL
);

CREATE INDEX links_source
ON links(source_page_id);

CREATE INDEX links_target
ON links(target_page_id);

CREATE INDEX links_broken
ON links(broken);
```

**实施决策（2026-08-31）**：采用「一个物理连接 + 两个逻辑表组」——泛化 per-vault 数据库连接持有者，Search 与 Link 表 DDL 在同一连接上 exec，避免两个 `DatabaseSync` 指向同一文件产生 `SQLITE_BUSY` 写冲突；links 相关 meta key 使用独立命名空间（`link_schema_version`）。

---

# 8. R010 Stage 0：Link Semantics Freeze

先冻结支持范围。

第一版支持：

```text
[标题](target.md)
[标题](./target.md)
[标题](../folder/target.md)
[标题](target.md#heading)
```

需要区分：

```text
internal link
external http/https
mailto
asset
anchor
broken internal link
```

必须覆盖：

```text
中文路径
空格
URL encoding
./
../
重复标题
fragment
文件移动
文件删除
```

第一版可以暂不支持复杂 Wiki Link 语法：

```text
[[Wiki Link]]
```

优先保证普通 Markdown Link 的跨工具兼容性。

**Stage 0 完成记录（2026-08-31）**：语义核心落位于 `shared/links/linkKind.ts`（`classifyLinkHref` / `resolveLinkPath` / `splitHref` / `decodeLinkPath`）+ `shared/links/types.ts`（`DocumentLink` / `Backlink`），冻结测试 `shared/links/linkSemantics.test.ts`（21 例，覆盖上文全部必测项）绿，typecheck / deps:check 通过。偏差：`src/editor/markdown/links.ts` 的旧 `resolveRelativePath` 保持不动（其 `..` 逃逸时静默夹取到根的语义有既有测试依赖）；新 `resolveLinkPath` 采用严格语义（逃逸返回 null，由索引层标 broken），两者并存，后续 Stage 逐步迁移调用方。

---

# 9. R010 Stage 1：Internal Link Editor

把当前 Mention 升级为真正的：

```text
InternalLink
```

用户体验仍保持：

```text
输入 @
→ 搜索页面
→ 选择
```

但 Editor Node 语义变成 `internalLink`，而不是仅展示 mention badge。

保存 Markdown：

```markdown
[页面标题](../目录/页面.md)
```

打开时：

```text
relative path
    ↓
LinkResolver
    ↓
stable target page id
    ↓
InternalLink Node
```

**Stage 1 完成记录（2026-08-31）**：`src/editor/internalLink.ts` 节点（inline atom，attrs `{id,label}`，自带 handleClick 点击插件经 `editor.storage.internalLinkServices.onOpenPage` 回调）；`@` suggestion 改插 internalLink（mention extension 保留渲染存量节点）；白名单同步（schema 同步测试自动覆盖）；serialize 复用 `resolveMentionPath`（签名未动），parse 侧新增可选 `resolveInternalLinkTarget` resolver，注入点为 Desktop 读侧唯一 codec.parse 调用点 `DesktopContentRepository.readNote`（经 `DesktopVaultScanCache` 新增 relativePath→pageId 反向索引）；DocumentEditor 新增可选 `onOpenPage` prop（onBeforeCreate storage 注入先例），DocumentScreen 接 `useNavigationCommands().openDocument`，Web/Desktop 同链路。382+305 例相关测试绿，typecheck/lint/deps:check 过。偏差：带 `#锚点` 或叠加样式 mark 的相对 .md 链接不升级为 internalLink（避免丢信息，保持 link mark）；`VaultImportService` 导入侧仍还原为 mention（行为兼容，后续清理）；`jsonToText` 不含链接标题（与 mention 现状一致）。Stage 2 一致性契约实测不受 parse 改写影响（未注入 resolver 时行为不变）。

---

# 10. R010 Stage 2：Link Extraction

新增纯函数：

```ts
extractDocumentLinks(
  contentJson,
  sourceContext,
): DocumentLink[]
```

不要从 `textSnapshot` 解析链接，必须从 Tiptap JSON 读取结构化节点，避免代码块里的 Markdown 示例被误判为真实链接。

**实施决策（2026-08-31）**：双提取器 + 共享语义核心——Renderer 保存侧从 Tiptap JSON 提取（本函数）；Main 索引侧从 Markdown 文本提取（围栏代码块屏蔽）。链接分类、相对路径解析、URL decoding 等语义核心放 `shared/links/`，契约测试锁定两提取器输出一致。

**Stage 2 完成记录（2026-08-31）**：`shared/links/extractDocumentLinks.ts`（JSON 侧，text link mark + internalLink/mention 节点 + image/attachment）、`shared/links/extractMarkdownLinks.ts`（Markdown 侧，剥 frontmatter + 屏蔽围栏/行内代码，支持平衡括号与尖括号空格路径）、`shared/links/extractLinksFixtures.ts`（15 条契约语料）+ 双提取器一致性测试 `src/editor/markdown/extractLinksConsistency.test.ts`（经 MarkdownCodec 实解析逐条全字段比对）。71 例测试绿。偏差与冻结的边界形态：裸空格目的地 `[a](my note.md)` 两侧一致不产出（合法形态为尖括号 `<…>`）；引用式链接/自动链接/Wiki 链接/label 嵌套方括号/href 反斜杠转义两侧一致不支持；链接文字含内联格式时 JSON 侧按 text 节点片段各产出一条（不跨节点合并）。已知交互点：Stage 1 的 parse 侧 `restoreInternalLinks` 接入后，一致性测试需给 parse 传恒 null resolver 保持纯路径形态比对（在 Stage 1 集成批处理）。

---

# 11. R010 Stage 3：Derived Link Index

首次打开 Vault：

```text
scan notes
    ↓
parse Markdown
    ↓
extract links
    ↓
resolve links
    ↓
SQLite links
```

查询 backlinks：

```sql
SELECT *
FROM links
WHERE target_page_id = ?
```

不能每次 UI 打开都扫描全部 Markdown。

**Stage 3 完成记录（2026-08-31）**：Port `shared/links/LinkIndex.ts`（prepare/rebuild/upsert/remove/relocate/getOutgoing/getBacklinks/getBrokenLinks/getStatus，状态复用 SearchIndexStatus 五态）；解析裁决唯一入口 `shared/links/resolveLinks.ts`（内存与 SQLite 双实现共用）；契约套件 `shared/links/linkIndexContract.ts` 双实现各 12 例绿；内存参照 `src/infrastructure/memory/linkIndex.ts`；Main 侧 `electron/main/index/VaultIndexConnection.ts` + `DesktopVaultIndexManager.ts`（per-vault 单连接共库：links 表组就地加入既有 `search-index/<vaultId>.sqlite`，meta key 独立命名空间 `link_schema_version`；任一方损坏 → 文件级 `.corrupt-<ts>` 备份重建，另一方经 generation 失效自动重初始化）、`electron/main/links/DesktopLinkDatabase.ts` + `DesktopLinkIndexer.ts`；IPC 八通道 `link:outgoing/backlinks/broken/rebuild/upsert/remove/relocate/status`（upsert 由 Main 自读盘，DSK-02）；Renderer `src/platform/desktop/DesktopLinkIndex.ts` + `AppServices.linkIndex?` 可选字段 + `createDesktopRuntime` 装配。偏差：§17 建议 schema 增加 `link_docs` 快照表（含 links_json 提取原文，支撑 relocate 重锚定与 Backlink.sourceTitle）；links 表主键用 `source_note_key`（对齐搜索 note_key 身份规则：stableNoteId ?? "path:<relativePath>"）。已知边界：Editor 节点引用（knownTargetPageId）的 broken 恢复目前只能靠源文档 upsert/rebuild（目标到达的反向 fix-up 只按 target_path 匹配），Stage 6 评估是否加列覆盖。全量 1483 例测试绿。

---

# 12. R010 Stage 4：Incremental Reconciliation

## E1 自己保存

```text
DocumentSaveCoordinator
    ↓
Markdown save success
    ↓
best-effort extract links
    ↓
replaceOutgoing(pageId)
```

如果 Link Index 更新失败：

```text
Markdown save = success
Link index = degraded
```

绝不能回滚正文保存。

## 外部修改

```text
Finder / VS Code / Git
    ↓
Markdown changed
    ↓
chokidar
    ↓
ExternalVaultChangeService
    ↓
LinkIndexReconciler
    ↓
replaceOutgoing
```

## 删除

```text
target file deleted
    ↓
targetPageId unresolved
    ↓
broken = true
```

## 恢复

```text
target restored
    ↓
stable id matched
    ↓
broken = false
```

**实施决策（2026-08-31）**：broken 是落库时的解析结果而非独立状态机——链接目标解析不到即 `broken=true`；目标恢复（stable id 重新出现）在 upsert/rebuild 重解析时自动 `broken=false`。

**Stage 4 完成记录（2026-08-31）**：`src/platform/desktop/DesktopLinkIndexReconciler.ts`（逐项对标搜索 reconciler：created/modified→upsert（Main 自读盘）、moved→relocate（多传 noteKey，契约显式支持已知稳定键直给）、deleted→remove（stable id 走 noteKey、path 身份走 relativePath）、自写 `onDocumentCommitted` 经 scans.findEntry 反解、`indexed:false` 自动补 remove 收口、任何失败 markDegraded + 30s 防抖 rebuild 且不抛错不阻断保存）；接线 `createDesktopRuntime.ts`（onCommitted 回调与 externalVaultChanges 订阅纯追加）与 `ExternalVaultChangeBridge.tsx`（prepare 自动入口追加 linkIndex）。178 例定向测试绿，typecheck/lint/deps:check 过。

---

# 13. R010 Stage 5：Backlinks UI

第一版建议不做 Graph Visualization。

优先做：

```text
引用此页面
```

例如：

```text
引用此页面 · 4

React 调度系统
「...Fiber 更新流程...」

前端性能优化
「...组件更新...」
```

支持点击来源直接打开来源文档。

同时支持：

```text
此页面引用
```

例如：

```text
此页面引用 · 3

React Fiber
Scheduler
Concurrent Rendering
```

**Stage 5 完成记录（2026-08-31）**：`src/components/document/DocumentLinksPanel.tsx`（「引用此页面 · N」backlinks 卡片：来源标题 + snippet，点击 `openDocument(sourcePageId)`；「此页面引用 · N」outgoing：internal 可点击跳转、broken 置灰 + 「目标不存在」徽标、external/mailto/asset/anchor 静态展示带种类徽标；building/degraded 状态条 + 重建按钮，复用 SearchPanel 风格），集成于 `DocumentScreen` 正文下方，`services.linkIndex` 存在性门控（Web 不渲染）。刷新策略：pageId 切换 + prepare 落定、savedAt 变化 400ms 防抖、订阅 externalVaultChanges 同 vault 批次防抖，三路汇入带 requestId 防过期的 refresh（不常驻轮询）。样式 `src/styles/components/document-links.css`（Cascade Layers 组件层 + 语义令牌）。8 例组件测试绿。已知边界（遗留 Stage 6/7 评估）：Adoption 同会话 noteKey 分叉——刚完成 Stable ID Adoption 的文档会话 pageId 仍为 `path:*` 而索引行以 stableNoteId 为键，面板查询短暂落空（重启自愈；Stage 1 internalLink 点击同边界），建议后续给 `DesktopLinkIndex` 注入 scans/aliases 做身份翻译。

---

# 14. R010 Stage 6：Broken Links

知识库增加：

```text
失效链接
```

例如：

```text
项目总结.md
→ ../archive/旧方案.md
目标不存在
```

支持：

```text
重新定位
```

流程：

```text
broken link
    ↓
TargetPicker
    ↓
选择新页面
    ↓
修改当前文档链接
    ↓
正常保存
```

第一版不做静默批量修复全部 Vault，因为可能涉及外部编辑器、dirty document、Git 未提交修改和用户刻意保留的历史引用。

**实施决策（2026-08-31）**：现有 `TargetPicker` 是「创建位置选择器」，不复用；重新定位使用新建页面选择器（mention CommandList 弹层为最接近先例）。

**Stage 6 完成记录（2026-08-31）**：编排 `DocumentCommandService.relocateBrokenLink({sourcePageId, oldHref, newTargetPageId})`（经 queries.document 打开源文档 → `src/application/links/rewriteLinkHref.ts` 不可变改写所有 href 精确等于 oldHref 的 link mark、保留 fragment → `documentCommit.commit` 统一写入通道 + 乐观锁；源文档编辑器打开且 dirty 时撞 DOCUMENT_CONFLICT 冲突面板，绝不静默覆盖；0 命中抛 INVALID_INPUT；错误分流复用既有 DomainError 码 PAGE_NOT_FOUND/DOCUMENT_SOURCE_CONTEXT_REQUIRED/INVALID_INPUT/NOT_IMPLEMENTED，未新增码）；`src/components/PagePicker.tsx`（Dialog + 搜索过滤 + CommandList 键盘导航）；`src/components/BrokenLinksPanel.tsx`（知识库级失效链接 Dialog，入口在 WorkspaceHome meta 行「重新扫描」旁，`services.linkIndex` 存在性门控）。25 例新测试绿，架构测试/typecheck/lint/deps:check 过。已知边界：internalLink/mention 节点引用 href 恒为空不支持重新定位（需 port 透出 knownTargetPageId，留后续）；目标路径经 openDocument 全量读文件获得（热点再优化）；源文档正打开且 clean 时编辑器视图不自动刷新（重开或 watcher 自愈）。

---

# 15. R010 Stage 7：Scale & Acceptance

规模目标延续 R008：

```text
1k
10k
50k
```

正式日用目标：

```text
10k documents
```

50k：

```text
no OOM
no permanent UI freeze
```

初始目标：

```text
10k rebuild links < 10s
single document link update < 100ms
backlinks query < 100ms
broken links query < 150ms
```

实际阈值由 benchmark 最终校准。

**Stage 7 完成记录（2026-08-31）**：基准实测（macOS arm64 开发机，`electron/main/links/DesktopLinkIndex.perf-wallclock.test.ts`，经 `iterateVaultLinkDocuments` 真实扫描管线驱动，语料由 `fixtures/search/generator.mjs` 新增可选 `links:true` 生成、种子确定性、既有语料逐字节不变）——10k：rebuild 2.1–2.5s、单篇 upsert 1.5–4ms、backlinks p95 0.8–4.7ms、broken 查询 4–9ms（1766 条 broken 语料），初始目标全部达标且余量约一个数量级；阈值维持初始值作趋势哨兵（与搜索基准同口径）。E2E：`e2e/desktop.links.spec.ts` G21–G30 合 5 例本地两轮全过（@ 插入/outgoing/点击打开/backlink、中文嵌套路径重启保持、外部编辑 watcher、删除→broken→恢复、重新定位落盘）；`e2e/package/desktop.package.links.spec.ts` P10–P12 本地无产物按 `requirePackagedArtifact()` 口径 skip（CI/release 管线执行）。同批修复 Stage 5/6 遗留的 Adoption noteKey 分叉：`DesktopLinkIndex` 注入 `DesktopVaultScanCache` 做会话身份翻译（`toNoteKey`/`toSessionPageId`/`toSessionLink`）。`npm run ci` 1526 例全绿、`build:desktop` 通过、`test:perf` 链接基准 2/2 过。已知 flake（非本批引入）：web persistence perf「中型回收站清空 <500ms」对机器负载敏感曾单发失败；ci 与 Playwright 不可并发（共用 `test-results/tmp`）。

---

# 16. R010 E2E

新增 macOS/Desktop Golden：

```text
G21  @ 插入内部链接
G22  保存 → 重启 → 链接仍可点击
G23  点击内部链接 → 打开目标文档
G24  目标页面显示 backlink
G25  来源页面显示 outgoing link
G26  外部编辑 Markdown 添加链接 → watcher → backlink 出现
G27  删除目标 → broken link
G28  恢复目标 → broken 自动恢复
G29  broken link 重新定位
G30  中文路径内部链接
```

Packaged App：

```text
P10  packaged E1.app 内部链接打开正常
P11  packaged E1.app backlinks 正常
P12  packaged E1.app watcher 更新 link index
```

全部只针对 macOS。

---

# 17. R010 非目标

R010 不包含：

- Knowledge Graph 可视化；
- Force-directed Graph；
- AI Graph；
- Semantic Links；
- Vector Embedding；
- RAG；
- Wiki Link 全套兼容；
- Block-level backlinks；
- Heading-level backlinks；
- Batch automatic rewrite；
- Group Rename；
- Group Move；
- Workspace Rename；
- Physical File Rename；
- Revision History；
- Windows；
- Linux。

---

# 18. R010 与 R011 的关系

当前 Desktop 仍然关闭：

```text
workspace.rename
document.renameFile
group.rename
group.move
```

这是合理的。

因为直接做物理 rename：

```text
React.md
→ React-Fiber.md
```

会让：

```markdown
[React](React.md)
```

全部断链。

R010 完成以后：

```text
LinkIndex.getBacklinks(pageId)
```

可以告诉 R011 这个文件被多少文档引用。

于是 R011 可以实现：

```text
rename preflight
    ↓
17 inbound links
    ↓
用户确认
    ↓
rename
    ↓
safe rewrite
```

因此顺序固定：

```text
R010 Links
    ↓
R011 File Operations v2
```
