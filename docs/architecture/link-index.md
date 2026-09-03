# 链接索引（Link Index，R010）

内部链接、反向链接与链接完整性的架构事实。需求与实施记录见
`docs/requirements/R010-internal-links-backlinks-link-integrity.md`；本文描述当前代码真相。

## 原则

- **LINK-01**：磁盘只存普通 Markdown 相对路径链接（`[标题](../目录/页面.md)`），无私有协议；
  Vault 兼容 VS Code / Typora / Obsidian / Git。
- **LINK-02**：磁盘身份 = 相对路径；运行时身份 = stable page id（Frontmatter noteId，
  缺失时 `path:<relativePath>`，与搜索索引同一规则）。两者明确分离。
- **LINK-03**：Link Index 是派生数据——可删除、可重建；损坏不影响 Markdown；
  索引更新失败不阻断正文保存（degraded + 30s 防抖重建）。
- **LINK-04**：不按 title 定位；链接经 `relative path → target file → stable note id` 解析。

## 分层

```text
Editor / Markdown
   ↓ extractDocumentLinks（Tiptap JSON）/ extractMarkdownLinks（Markdown 文本）
   ↓ 共享语义核心 shared/links（classifyLinkHref / resolveLinkPath / resolveExtractedLinks）
LinkIndex Port（shared/links/LinkIndex.ts）
   ├─ Desktop：DesktopLinkIndex（IPC）→ electron/main/links/DesktopLinkDatabase（SQLite，共库）
   └─ 内存参照：src/infrastructure/memory/linkIndex.ts（契约基准 + 内存容器）
```

- 链接分类：`internal`（相对 .md）/ `external`（协议、`//`、绝对路径）/ `mailto` /
  `asset`（相对非 .md）/ `anchor`（纯 `#` 片段）。路径归一前百分号解码；
  `..` 越过 vault 根返回 null（索引层标 broken）。
- `broken` 是落库时的解析结果（目标路径解析不到 stable id），不是独立状态机；
  目标恢复（文件重建/stable id 再现）在 upsert/relocate/rebuild 重解析时自动复原。
- 解析裁决唯一入口 `shared/links/resolveLinks.ts`，内存与 SQLite 双实现共用；
  行为由 `shared/links/linkIndexContract.ts` 契约套件锁定（双实现各 12 例）。

## SQLite 共库

- `electron/main/index/VaultIndexConnection.ts`：per-vault 单连接持有者（懒打开 +
  文件级损坏自愈 + generation 代数）；`DesktopVaultIndexManager` 按 vault 懒建
  `{connection, search, link}`。
- Search 与 Link 表组共用 `userData/search-index/<vaultId>.sqlite` 的同一 `DatabaseSync`
  （避免双连接 SQLITE_BUSY）；links 表组 meta key 独立命名空间
  `link_schema_version` / `link_index_format_version`；任一方发现损坏 → 整库
  `.corrupt-<ts>` 备份重建（双方都是派生数据，同生共死）。
- links 表：`links(source_note_key, target_note_key, target_path, href, label,
fragment, link_kind, broken, source_version)` + source/target/broken 三索引；
  另有 `link_docs` 快照表（含提取原文 links_json，支撑 relocate 重锚定与
  Backlink.sourceTitle）。

## 增量维护（Desktop）

```text
E1 保存：DocumentCommitService → DesktopTitleSearchIndex.onCommitted
         → DesktopLinkIndexReconciler.onDocumentCommitted → upsert（Main 自读盘）
外部变更：VaultWatcher → ExternalVaultChangeService
         → DesktopLinkIndexReconciler.reconcile（created/modified→upsert、
           moved→relocate、deleted→remove）
```

- upsert 返回 `indexed:false`（文件已消失）→ 自动补 remove；任何失败 →
  markDegraded + 30s 防抖 rebuild，绝不向上抛错。
- `ExternalVaultChangeBridge` 打开工作区时 `linkIndex.prepare(vaultId)` 自动建库。

## 编辑器与 UI

- `internalLink` 节点（inline atom，attrs `{id, label}`）：`@` 插入的目标形态；
  mention 节点保留渲染存量文档。序列化 `[label](relativePath)`（复用
  `resolveMentionPath`）；解析侧 `restoreInternalLinks` 经
  `resolveInternalLinkTarget` resolver（Desktop 注入点
  `DesktopContentRepository.readNote`，经 `DesktopVaultScanCache` 反向索引）
  把可解析的相对 .md link mark 还原为 internalLink，解析不到保持 link mark。
  带 `#锚点` 或叠加样式 mark 的链接不升级（避免丢信息）。
- 点击导航：节点 handleClick → `editor.storage.internalLinkServices.onOpenPage`
  → `useNavigationCommands().openDocument`（DocumentScreen 注入，双端同链路）。
- `DocumentLinksPanel`（文档底部「引用此页面 / 此页面引用」）与
  `BrokenLinksPanel`（WorkspaceHome「失效链接」入口 + PagePicker 重新定位）
  均按 `AppServices.linkIndex` 存在性门控（Web 不装配即不出现，DUAL-01）。
- 重新定位编排：`DocumentCommandService.relocateBrokenLink`（改写源文档中所有
  href 精确等于 oldHref 的 link mark → `documentCommit.commit` 统一写入通道 +
  乐观锁；dirty 冲突走 DOCUMENT_CONFLICT 面板，绝不静默覆盖）。
- 身份翻译：`DesktopLinkIndex` 注入 `DesktopVaultScanCache`
  （toNoteKey/toSessionPageId），消除 Stable ID Adoption 同会话分叉。

## 验收口径

- 性能（10k 文档，macOS arm64）：rebuild 2.1–2.5s、单篇 upsert 1.5–4ms、
  backlinks p95 < 5ms、broken 查询 < 10ms（基准测试阈值保持初始目标作趋势哨兵）。
- E2E：`e2e/desktop.links.spec.ts`（G21–G30）、
  `e2e/package/desktop.package.links.spec.ts`（P10–P12，随 release 管线执行）。
