# R009 收口与 R010 规划：macOS 单平台路线

> 版本：0.1  
> 状态：已采纳（R009 收口部分 2026-08-30 落地：AIDraftModal 代次守卫 + 发布链路去 Windows + 文档回写；首次真实 tag 发布待执行。R010 规划部分待启动）  
> 更新时间：2026-08-30  
> 适用平台：macOS（当前唯一 Desktop 目标平台）  
> 基线提交：`0b439a7192d7473aff3e775eb15a1e0ecb0beccc`  
> 前置需求：R006、R007、R008、R009  

---

# 1. 决策摘要

从本阶段开始，E1 Desktop 暂时只面向 macOS。

因此后续规划统一采用以下平台策略：

```text
Desktop Target
=
macOS only
```

暂不投入：

- Windows 安装包；
- Windows packaged E2E；
- Windows NSIS；
- Windows Authenticode；
- Windows SmartScreen 适配；
- Windows Auto Update；
- Windows 文件管理器行为兼容；
- Linux Desktop 分发；
- Linux Desktop 安装包；
- Linux Desktop 自动更新。

现有代码中已经存在的 Windows 配置允许保留，但不作为当前需求目标、CI 必过条件、Release DoD、R009 完成门槛或 R010 验收范围。

除非未来明确重新开启多平台支持，否则后续 Desktop 产品设计、测试、发布和性能验收都以 macOS 为准。

---

# 2. 当前 R009 完成状态

最新 `main`：

```text
0b439a7192d7473aff3e775eb15a1e0ecb0beccc
feat(R009): Stage 6 Auto Update——electron-updater + GitHub Releases
```

当前远端 CI 已恢复为全绿：

```text
quality              ✅
build-web            ✅
build-desktop        ✅
desktop-runtime-deps ✅
e2e-web              ✅
e2e-desktop          ✅
```

R009 已经完成的主要能力：

```text
Remote Green Baseline
Product Identity
Legacy userData Migration
electron-builder Packaging
Packaged App E2E
Release Workflow
Auto Update
```

产品身份已经冻结为：

```text
package name = e1
productName  = E1
appId        = com.e1.notes
version      = 0.1.0
```

---

# 3. R009 平台范围调整

原 R009 曾规划：

```text
macOS arm64
+
Windows x64
```

现在调整为：

```text
macOS arm64
```

第一阶段不要求：

```text
macOS x64
Universal Binary
Windows x64
Linux
```

如果未来出现 Intel Mac 用户需求，再独立评估 `macOS universal`，而不是当前提前扩大构建矩阵。

---

# 4. R009 中需要修改的内容

## 4.1 Release Workflow

现有 Release Workflow 中的 Windows matrix：

```text
windows-latest
→ dist:win
→ NSIS
```

不再作为当前发布流程的一部分。

推荐调整为：

```text
tag vX.Y.Z
    ↓
version-check
    ↓
quality
    ↓
build-verify
    ↓
macOS arm64 package
    ↓
Packaged App E2E
    ↓
SHA256SUMS
    ↓
GitHub Release
```

最终只发布：

```text
E1-x.y.z-arm64.dmg
E1-x.y.z-arm64.zip
latest-mac.yml
*.blockmap
SHA256SUMS.txt
```

## 4.2 package.json

现有：

```json
{
  "dist:mac": "...",
  "dist:win": "..."
}
```

`dist:win` 可以暂时保留作为未来能力，但不进入 README 主流程、不进入 R009 DoD、不进入 Release Workflow，也不要求持续验证。

如果希望工程状态与产品事实完全一致，可以直接移除 `dist:win`，未来恢复 Windows 时再通过独立需求加入。

推荐当前保留：

```text
package:desktop
dist:mac
```

## 4.3 electron-builder.yml

目标平台明确：

```yaml
mac:
  target:
    - dmg
    - zip
```

Windows 配置有两种处理：

### 方案 A：保留但不使用

优点是将来恢复 Windows 成本低；缺点是容易让文档和代码产生“当前支持 Windows”的错觉。

### 方案 B：当前删除

优点是配置与产品事实完全一致，也能减少维护面。

推荐：**当前删除 Windows builder 配置**。未来确实决定做 Windows 时，通过新的需求重新引入。

---

# 5. R009 Signing 策略调整

当前唯一需要考虑的是 macOS：

```text
Developer ID Application
Hardened Runtime
Notarization
Stapling
```

现状：

```text
identity: null
```

因此当前包属于：

```text
Unsigned macOS Distribution
```

可以开发、自测和内部使用，但正式面向普通用户分发时会受到 Gatekeeper 影响。

签名仍允许延期，并独立记录为：

```text
R013：macOS Signing & Trust
```

在拿到 Apple Developer 证书以后实施。

R009 当前不因为没有签名而继续保持“实现中”。只要未签名状态被明确记录、用户下载路径与风险说明清晰，即可关闭 R009。

---

# 6. R009 Auto Update 调整

现有 Auto Update 里 Windows 自动安装链路不再作为当前产品目标。

只保留 macOS 语义：

```text
macOS unsigned
    ↓
checkForUpdates
    ↓
发现新版本
    ↓
显示版本信息
    ↓
打开 GitHub Release 下载
```

当前：

```text
canAutoInstall = false
```

是合理行为。

未来完成 macOS Signing 后再升级：

```text
canAutoInstall = true
```

然后支持：

```text
检查
→ 下载
→ 用户确认
→ 安装
→ 重启
```

---

# 7. R009 Closeout

R009 不再要求 Windows 验收。

新的关闭条件：

## CI

- [x] latest remote main 全绿；
- [x] 无 Vitest unhandled errors；
- [x] Desktop E2E 全绿；
- [x] runtime dependencies 验证通过。

## macOS Packaging

- [x] `dist:mac` 可生成 DMG；
- [x] `dist:mac` 可生成 ZIP；
- [x] packaged `.app` 可启动；
- [x] packaged `.app` 不依赖仓库 node_modules；
- [x] Vault 可打开；
- [x] Markdown 可保存；
- [x] 附件正常；
- [x] SQLite 搜索正常；
- [x] watcher 正常；
- [x] safeStorage 按系统能力工作；
- [x] Reveal 可工作。

## Release

- [ ] 实际创建一次 macOS `v0.1.0` tag；
- [ ] Release Workflow 成功；
- [ ] GitHub Release 中存在 DMG；
- [ ] GitHub Release 中存在 ZIP；
- [ ] GitHub Release 中存在 updater metadata；
- [ ] SHA256SUMS 正确。

## Deferred

- [ ] Developer ID 签名；
- [ ] Notarization；
- [ ] Stapling。

上述 Deferred 迁移到独立需求 `R013 macOS Signing & Trust`，不继续阻塞 R009。

---

# 8. R009 关闭前建议顺手修复

## AIDraftModal async lifecycle

R009 Stage 0 修复了 `AIAssistantPanel` 卸载后异步请求返回继续 `setState` 的问题，但 `AIDraftModal.generate()` 仍然存在同型风险：

```ts
const result = await provider.complete(...);

setDraft(result);
setStep("preview");
```

如果用户：

```text
开始生成
→ 关闭 Dialog
→ provider 返回
```

组件可能已经卸载。

建议统一使用：

```text
request generation token
```

或通用：

```text
useAsyncGeneration()
```

避免未来继续出现 async completion after unmount。

这一项建议作为 R009 Closeout patch 完成。

---

# 9. R009 最终建议状态

完成：

```text
macOS v0.1.0 实际 Release
+
AIDraftModal async lifecycle fix
```

之后：

```text
R009 = 已完成
```

不要因为暂时不支持 Windows 继续让 R009 长期保持“实现中”。

---

# 10. 下一阶段：R010

# R010：内部链接、反向链接与链接完整性

英文：

```text
Internal Links, Backlinks & Link Integrity
```

---

# 11. 为什么现在优先做 R010

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

# 12. 当前已经存在的基础

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

# 13. R010 核心原则

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

# 14. R010 架构

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

# 15. 数据模型

建议：

```ts
interface DocumentLink {
  sourcePageId: string;

  href: string;
  label: string;

  kind:
    | "internal"
    | "external"
    | "asset"
    | "anchor";

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

# 16. LinkIndexPort

推荐：

```ts
interface LinkIndexPort {
  prepareWorkspace(
    workspaceId: string,
  ): Promise<void>;

  replaceOutgoing(
    pageId: string,
    links: DocumentLink[],
  ): Promise<void>;

  getOutgoing(
    pageId: string,
  ): Promise<DocumentLink[]>;

  getBacklinks(
    pageId: string,
  ): Promise<Backlink[]>;

  getBrokenLinks(
    workspaceId: string,
  ): Promise<DocumentLink[]>;

  rebuild(
    workspaceId: string,
  ): Promise<void>;
}
```

不要让 components、application、domain 直接 import SQL / SQLite。

---

# 17. SQLite Schema 建议

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

---

# 18. R010 Stage 0：Link Semantics Freeze

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

---

# 19. R010 Stage 1：Internal Link Editor

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

---

# 20. R010 Stage 2：Link Extraction

新增纯函数：

```ts
extractDocumentLinks(
  contentJson,
  sourceContext,
): DocumentLink[]
```

不要从 `textSnapshot` 解析链接，必须从 Tiptap JSON 读取结构化节点，避免代码块里的 Markdown 示例被误判为真实链接。

---

# 21. R010 Stage 3：Derived Link Index

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

---

# 22. R010 Stage 4：Incremental Reconciliation

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

---

# 23. R010 Stage 5：Backlinks UI

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

---

# 24. R010 Stage 6：Broken Links

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

---

# 25. R010 Stage 7：Scale & Acceptance

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

---

# 26. R010 E2E

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

# 27. R010 非目标

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

# 28. R010 与 R011 的关系

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

---

# 29. 后续路线

推荐：

```text
R009 Closeout
macOS v0.1.0 real release
+ async lifecycle cleanup
        ↓

R010
Internal Links & Backlinks
        ↓

R011
Desktop File Operations v2
        ↓

R012
Desktop Revision History
        ↓

R013
macOS Signing & Trust
```

如果 Apple Developer 证书提前准备好，R013 可以随时插入，不必等 R012。

---

# 30. macOS 单平台原则

## MAC-01

Desktop 目标平台暂时只有：

```text
darwin
```

## MAC-02

不能为了未来可能支持 Windows，提前扩大当前需求范围。

## MAC-03

跨平台抽象仍然保留：

```text
AppServices
Capabilities
RuntimeOperations
Ports / Adapters
```

但当前只验证：

```text
Web
+
macOS Desktop
```

## MAC-04

Main 代码避免无必要写死 macOS 绝对路径。

例如仍然优先：

```text
app.getPath()
path.join()
```

而不是：

```text
~/Library/...
```

这样未来恢复跨平台时不用重写核心逻辑。

## MAC-05

平台专属能力允许明确：

```text
darwin only
```

而不是为了“看起来跨平台”引入没有被测试过的抽象。

---

# 31. 当前推荐执行顺序

第一步：

```text
R009 Closeout
```

完成：

```text
AIDraftModal async guard
Release Workflow 去 Windows matrix
electron-builder 去 Windows config
实际 tag v0.1.0
验证 macOS GitHub Release
R009 → 已完成
```

第二步：

```text
R010 Stage 0
Link Semantics Freeze
```

第三步：

```text
InternalLink
```

第四步：

```text
Link Extractor
+
Link Index
```

第五步：

```text
Watcher Incremental Reconciliation
```

第六步：

```text
Backlinks UI
+
Outgoing Links
```

第七步：

```text
Broken Links
+
Repair
```

最后：

```text
10k scale
macOS packaged E2E
R010 close
```

---

# 32. 最终方向

当前项目已经具备：

```text
Local-first Markdown
+
Desktop App
+
Search
+
Packaging
+
Update
```

下一阶段最值得投入的不是继续扩展平台，而是提升知识组织能力：

```text
Markdown Files
    ↓
Internal Links
    ↓
Backlinks
    ↓
Link Integrity
    ↓
Linked Knowledge Base
```

因此正式建议：

> 先以 macOS 为唯一 Desktop 平台完成 R009 发布闭环，然后进入 R010「内部链接、反向链接与链接完整性」。
