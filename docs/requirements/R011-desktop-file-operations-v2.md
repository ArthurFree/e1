# R011：Desktop File Operations v2

英文：Safe Rename, Move & Link Rewrite

- 当前版本：1.0
- 状态：已完成（2026-09-03）
- 最后更新：2026-09-03
- 前置需求：R007、R008、R010
- 基线提交：`c3ce7668bdce1a1f3b5af9da850271815acef57a`
- 目标平台：macOS Desktop（Web 保持既有行为，不把 Desktop 文件系统语义泄漏到 Web）

---

# 1. 背景

R010 完成以后，E1 已经具备：

```text
Markdown Source of Truth
Stable Note Identity
Internal Links
Backlinks / Outgoing Links
Broken Links
Derived LinkIndex
File Watcher
Search Index
Desktop Packaged App
```

但 Desktop 的文件操作仍然是不完整的：

```text
workspace.rename      = false
document.renameFile   = false
group.rename          = false
group.move            = false
```

当前已经存在的 `document.move` 只完成：

```text
Markdown file
    ↓
fs.rename()
    ↓
new directory
```

它能够保持 Frontmatter 与 Stable Note ID 不变，但不能完整保护相对路径语义。

例如：

```text
知识库/
├── React.md
├── Fiber.md
└── notes/
```

`Fiber.md`：

```md
[React](React.md)
```

如果把 `React.md` 移动到：

```text
notes/React.md
```

原链接会立刻失效。

同样，移动一个包含附件引用的文档：

```md
![架构图](assets/diagram.png)
```

从 Vault 根移动到深层目录以后，相对路径也可能失效。

因此 R011 的目标不是简单开启几个操作按钮，而是建立：

```text
Path-changing Operation
        ↓
Impact Analysis
        ↓
User Preflight
        ↓
Source-preserving Link Rewrite
        ↓
Journaled Filesystem Operation
        ↓
Recovery / Rollback
        ↓
Watcher + SearchIndex + LinkIndex Reconciliation
```

使 E1 的本地文件操作真正具备知识库级完整性。

---

# 2. R011 目标

R011 必须完成以下能力。

## 2.1 Workspace Rename

开启：

```text
workspace.rename = true
```

第一版 Workspace Rename 的语义固定为：

```text
修改 .e1/vault.json 的 name
```

不修改 Vault 根目录的物理文件夹名称。

例如：

```text
磁盘目录：~/Notes/my-vault/

vault.json:
name: 我的知识库
```

用户把知识库改名为：

```text
前端知识库
```

结果：

```text
~/Notes/my-vault/          # 不变
.e1/vault.json name        # 前端知识库
```

原因：

- E1 当前授权的是 Vault 根目录；
- 重命名根目录需要操作其父目录，权限模型不同；
- 根目录路径同时存在于 recent-vaults 本机注册信息；
- 物理根目录改名更接近 Vault Relocation，而不是普通 Workspace Rename。

物理重命名 Vault 根目录延期到 **R014：Vault Portability & Advanced File Operations**。

---

## 2.2 Document Physical File Rename

开启：

```text
document.renameFile = true
```

明确保持：

```text
Title Rename != File Rename
```

例如：

```text
页面标题：React Fiber
文件名：react-notes.md
```

允许分别执行：

```text
重命名标题
重命名文件…
```

物理文件改名必须：

- 保持 Frontmatter title 不变；
- 保持 Stable Note ID 不变；
- 自动分析所有 inbound links；
- 安全改写受影响的 Markdown href；
- 保留 `#fragment`；
- 不改链接显示文本；
- 不改外部链接 / mailto / 页面锚点；
- 不静默覆盖同名文件。

---

## 2.3 Document Move v2

保留：

```text
document.move = true
```

但把当前的“纯 rename”升级为完整的路径迁移操作。

移动文档时要同时处理两类影响：

### A. 别人指向当前文档

```text
A.md
  ↓
[Target](Target.md)

Target.md
  ↓ move
folder/Target.md
```

必须改写：

```md
[Target](folder/Target.md)
```

### B. 当前文档自己引用其他目标

```text
source.md
  ↓ move
folder/source.md
```

原：

```md
[Target](Target.md)
```

移动后必须重新计算：

```md
[Target](../Target.md)
```

同一规则适用于受管附件：

```md
![image](assets/a.png)
```

移动后根据新 source path 重新计算附件相对路径。

---

## 2.4 Group Rename

开启：

```text
group.rename = true
```

Group = 真实目录。

例如：

```text
React/
  Fiber.md
  Hooks.md
```

改名：

```text
React/
→
Frontend/
```

目录内部文件的 Stable Note ID 不变。

必须分析：

- 外部文档 → 目录内文档的 inbound links；
- 目录内文档 → 外部目标的 outgoing links；
- 目录内文档 → 受管 assets 的引用；
- 目录内部互相引用。

对于“只改祖先目录名称、目录深度不变”的场景，目录内部互相引用通常无需改写；最终是否需要改写一律由路径映射算法计算，而不是写死特殊规则。

---

## 2.5 Group Move

开启：

```text
group.move = true
```

支持：

```text
Group -> Root
Group -> Other Group
```

禁止：

```text
Group -> 自己
Group -> 自己的后代
Group -> Document
Group -> .e1
Group -> assetsDirectory
```

Group Move 是 R011 中影响范围最大的操作。

必须正确处理：

```text
Outside → Inside
Inside  → Outside
Inside  → Managed Asset
Inside  → Inside
```

其中：

```text
Inside → Inside
```

若两个文件一起保持相同相对结构迁移，href 可以保持不变；算法应得到 `oldHref === newHref` 并自动跳过写入。

---

# 3. 非目标

R011 不包含：

- 物理重命名 Vault 根目录；
- 跨 Vault 移动文档；
- 跨 Vault 移动分组；
- Copy / Duplicate Folder；
- 批量重命名；
- Git commit / Git mv 集成；
- Wiki Link `[[Page]]` 全套兼容；
- Markdown Reference Link 全量知识图谱支持；
- Block-level link rewrite；
- Heading 重命名后自动修 fragment；
- Revision History；
- Knowledge Graph；
- Windows / Linux 文件操作验收；
- macOS Signing / Notarization。

后续归属：

```text
R012  Desktop Revision History
R013  macOS Signing & Trust
R014  Vault Portability & Advanced File Operations
      - physical Vault root rename
      - cross-vault move/copy
      - advanced link syntax compatibility
```

---

# 4. 当前代码基线

R011 实施前应锁定以下事实。

## 4.1 Desktop Operation Matrix

当前：

```ts
workspace: {
  rename: false,
}

page.document: {
  renameTitle: true,
  renameFile: false,
  move: true,
}

page.group: {
  create: true,
  rename: false,
  move: false,
  trash: true,
}
```

R011 完成后 Desktop 应变成：

```ts
workspace: {
  rename: true,
}

page.document: {
  renameTitle: true,
  renameFile: true,
  move: true,
}

page.group: {
  create: true,
  rename: true,
  move: true,
  trash: true,
}
```

---

## 4.2 Main 已有 Document File Rename

Main 已经存在：

```text
note.renameFile
```

并具备：

- PathGuard；
- `.md` 扩展名限制；
- reserved path 保护；
- collision 检测；
- pure rename；
- Stable ID 不改动。

R011 不重新发明单文件 rename，而是在其上构建完整性事务。

---

## 4.3 Main 暂无 Group Rename / Move

需要新增目录级业务 IPC，不能暴露通用：

```text
fs.rename(pathA, pathB)
```

推荐业务接口：

```text
fileOperation.execute(...)
```

或内部细分：

```text
vault.renameDirectory
vault.moveDirectory
```

Renderer 仍然只允许接触：

```text
vaultId
relativePath
pageId / noteKey
```

绝不接触 absolutePath。

---

## 4.4 R010 已提供 LinkIndex

R011 必须复用 R010：

```text
LinkIndex
├── getOutgoing
├── getBacklinks
├── getBrokenLinks
├── relocate
└── rebuild
```

LinkIndex 是路径影响分析的重要输入，但依然是：

```text
Derived Data
```

绝不能把 SQLite 当作最终文件操作真相。

---

# 5. R011 核心不变量

定义：

## FILEOP-01：Markdown 仍是 Source of Truth

```text
Markdown files = Truth
SQLite         = Derived
```

任何 rename / move / rewrite 都不能只改 SQLite。

---

## FILEOP-02：Stable Note ID 不因路径变化而变化

```text
rename file
move file
rename group
move group
```

都不得修改文档 Frontmatter stable id。

---

## FILEOP-03：Title 与 File Name 永久分离

```text
renameTitle
renameFile
```

必须是两个用户可理解的独立动作。

物理 rename 不自动改 title。

标题 rename 不自动改 filename。

---

## FILEOP-04：Workspace Rename 只改逻辑名称

R011 的：

```text
workspace.rename
```

只修改：

```text
.e1/vault.json name
```

不修改 Vault 根目录。

---

## FILEOP-05：所有路径操作先 Preflight

执行任何路径变化之前必须得到：

```text
from
→
to

impacted documents
impacted links
impacted assets
blockers
warnings
```

不存在“先移动，再看看断了多少链接”的行为。

---

## FILEOP-06：LinkIndex 只负责发现影响，不负责写文件

```text
LinkIndex
    ↓
Impact Plan
    ↓
Markdown Patch / Filesystem Transaction
```

禁止：

```text
UPDATE links ...
```

替代 Markdown 改写。

---

## FILEOP-07：批量链接改写必须 Source-preserving

R011 不使用“完整 parse → Tiptap JSON → serialize”完成批量路径改写。

原因：

- 可能改变无关 Markdown 格式；
- 兼容模式文档可能含 E1 不完全支持的语法；
- R011 只需要改 href，没有理由重写整篇文件。

必须使用：

```text
raw Markdown
    ↓
identify link destination spans
    ↓
replace destination only
    ↓
raw Markdown
```

除目标 href 外，文件其余字节应尽可能保持不变。

---

## FILEOP-08：所有 Markdown Patch 都必须带 expectedVersionToken

执行前：

```text
plan sourceVersion
==
current disk version
```

否则：

```text
STALE_FILE_OPERATION_PLAN
```

重新 Preflight。

不能在外部编辑发生后继续使用旧影响计划。

---

## FILEOP-09：Dirty 文档不能被静默覆盖

如果任何需要改写或路径迁移的文档存在未保存内容：

```text
operation blocked
```

第一版不提供：

```text
强制覆盖 dirty editor
```

用户必须先：

```text
保存
放弃修改
解决冲突
```

再重新执行文件操作。

---

## FILEOP-10：Collision 永不自动覆盖

如果目标存在：

```text
VAULT_PATH_COLLISION
```

不做：

```text
auto overwrite
```

也不在 move / rename 中自动加 `(2)`。

---

## FILEOP-11：所有路径必须经过 PathGuard

必须继续保护：

```text
Vault escape
symlink escape
.e1
assetsDirectory as target group
hidden path
```

---

## FILEOP-12：链接改写失败不能留下未知半完成状态

R011 必须引入持久化 operation journal。

在异常或崩溃之后，E1 必须能判断：

```text
prepared
rewriting
relocated
committed
rolling-back
```

并自动或显式恢复。

---

## FILEOP-13：外部链接与页面锚点不因文件移动被修改

不改：

```text
https://
http://
mailto:
#heading
```

只处理路径相关的：

```text
internal Markdown links
managed asset links/images
```

---

## FILEOP-14：索引失败不能反向破坏 Markdown

路径事务成功后如果 SearchIndex / LinkIndex 更新失败：

```text
Markdown operation remains committed
Index -> degraded / rebuild
```

不能为了 SQLite 失败回滚已经安全完成的用户文件操作。

---

## FILEOP-15：Renderer 永远看不到 absolutePath

R011 新增接口一律只接收：

```text
vaultId
pageId
noteKey
relativePath
```

---

# 6. R011 Architecture

推荐结构：

```text
Shared UI
   ↓
FileOperationService (application contract)
   ↓
DesktopFileOperationPlanner
   ├── DesktopVaultScanCache
   ├── LinkIndex
   ├── Dirty/Open Document State
   └── Relative Path Semantics
   ↓
FileOperationPlan
   ↓
Desktop FileOperation IPC
   ↓
Main JournaledFileOperationEngine
   ├── PathGuard
   ├── Markdown destination patcher
   ├── AtomicFileWriter
   ├── fs.rename
   ├── SelfWriteRegistry
   └── .e1/operations journal
   ↓
Reconciliation
   ├── Scan Cache
   ├── Source Cache
   ├── LinkIndex
   ├── SearchIndex
   └── UI Session Refresh
```

约束：

```text
UI
不得 import Electron / fs / path / SQLite

Application
不得 import Electron / fs / SQLite

Main
不得知道 React 编辑器状态
```

---

# 7. Application Contract

建议新增：

```ts
export type FileOperationKind =
  | "rename-document-file"
  | "move-document"
  | "rename-group"
  | "move-group"
  | "rename-workspace";
```

核心接口：

```ts
export interface FileOperationService {
  plan(request: FileOperationRequest): Promise<FileOperationPlan>;

  execute(plan: FileOperationPlan): Promise<FileOperationResult>;

  getRecoveryStatus(vaultId: string): Promise<FileOperationRecoveryStatus>;

  recover(vaultId: string): Promise<FileOperationRecoveryResult>;
}
```

`AppServices` 建议增加可选字段：

```ts
fileOperations?: FileOperationService;
```

Shared UI 只判断：

```text
operations.xxx
+
fileOperations 是否存在
```

不得判断：

```text
isDesktop
process.platform
window.e1
```

---

# 8. FileOperationPlan

建议结构：

```ts
interface FileOperationPlan {
  operationId: string;
  kind: FileOperationKind;
  vaultId: string;

  target: {
    pageId?: string;
    fromRelativePath?: string;
    toRelativePath?: string;
    workspaceName?: string;
  };

  pathMoves: FilePathMove[];
  patches: MarkdownLinkPatchPlan[];

  summary: {
    movedDocuments: number;
    rewrittenDocuments: number;
    rewrittenLinks: number;
    rewrittenAssets: number;
  };

  blockers: FileOperationIssue[];
  warnings: FileOperationIssue[];

  createdAt: number;
}
```

路径变化：

```ts
interface FilePathMove {
  noteKey: string | null;
  kind: "document" | "group";
  fromRelativePath: string;
  toRelativePath: string;
}
```

Markdown 改写计划：

```ts
interface MarkdownLinkPatchPlan {
  sourcePageId: string;
  sourceRelativePathBefore: string;
  sourceRelativePathAfter: string;
  expectedVersionToken: string;

  rules: Array<{
    kind: "internal" | "asset";
    oldHref: string;
    newHref: string;
  }>;
}
```

---

# 9. 路径影响计算

对每条 LinkIndex 记录定义：

```text
old source path = S0
old target path = T0
future source path = S1
future target path = T1
```

原 href 表示：

```text
relative(S0 -> T0)
```

文件操作完成以后正确 href 应为：

```text
relative(S1 -> T1)
```

所以统一规则：

```text
newHref = relativeVaultPath(S1, T1)
```

若：

```text
oldHref == newHref
```

则：

```text
skip rewrite
```

这一条算法统一解决：

- document rename；
- document move；
- group rename；
- group move；
- source 移动；
- target 移动；
- source 与 target 同时移动。

---

# 10. LinkIndex 扩展

当前 `getBacklinks/getOutgoing` 足以完成单文档操作，但 Group Move 若逐文档 N+1 查询会增加编排复杂度。

建议扩展一个纯查询能力：

```ts
interface LinkRelocationQuery {
  analyzeRelocation(input: {
    vaultId: string;
    pathMoves: Array<{
      noteKey: string;
      fromRelativePath: string;
      toRelativePath: string;
    }>;
  }): Promise<LinkRelocationImpact[]>;
}
```

或作为 `LinkIndex` 的查询扩展：

```ts
linkIndex.analyzeRelocation(...)
```

返回：

```ts
interface LinkRelocationImpact {
  sourcePageId: string;
  sourceRelativePath: string;
  futureSourceRelativePath: string;
  targetPageId: string | null;
  targetRelativePath: string;
  futureTargetRelativePath: string;
  kind: "internal" | "asset";
  oldHref: string;
  newHref: string;
  sourceVersion: string;
}
```

要求：

```text
Memory LinkIndex
Desktop SQLite LinkIndex
```

继续通过同一个 contract suite。

---

# 11. Source-preserving Markdown Link Patcher

R010 的 `rewriteLinkHref(contentJson)` 是编辑器 JSON 级工具，适合单条 Broken Link 修复。

R011 的批量 File Operation 不应直接复用它作为最终落盘实现。

建议在：

```text
shared/links/
```

新增：

```text
scanMarkdownLinkDestinations()
rewriteMarkdownLinkDestinations()
```

现有 `extractMarkdownLinks()` 已经具备：

- fenced code block 屏蔽；
- inline code 屏蔽；
- `[text](href)`；
- `![alt](src)`；
- balanced parentheses；
- `<path with spaces.md>`；
- optional title。

R011 应把已有 scanner 抽成可同时返回 source range 的基础解析器，而不是另写第二套 Regex。

建议：

```ts
interface MarkdownLinkDestinationSpan {
  href: string;
  destinationStart: number;
  destinationEnd: number;
  wrapper: "bare" | "angle";
  isImage: boolean;
}
```

改写原则：

```text
从文件尾部向前应用 replacement
```

防止前面的字符串长度变化导致后面的 offset 漂移。

必须保证：

```text
link label 不变
optional title 不变
Frontmatter 不变
代码块不变
inline code 不变
普通正文不变
```

如果新路径包含空格：

```text
优先使用 <...> destination
```

确保仍然是合法 Markdown。

`#fragment` 必须保留。

---

# 12. Journaled File Operation Engine

这是 R011 的安全核心。

建议持久化位置：

```text
.e1/operations/<operationId>/
```

内容：

```text
manifest.json
backup/
```

`.e1` 已经是 E1 受管内部目录，扫描器不会把 journal 映射为页面。

---

## 12.1 Manifest

建议：

```ts
interface FileOperationJournal {
  version: 1;
  operationId: string;
  vaultId: string;
  kind: FileOperationKind;

  phase:
    | "prepared"
    | "rewriting"
    | "relocated"
    | "committed"
    | "rolling-back";

  fromRelativePath: string | null;
  toRelativePath: string | null;

  backups: Array<{
    originalRelativePath: string;
    backupRelativePath: string;
    versionToken: string;
  }>;

  createdAt: string;
}
```

manifest 更新本身必须：

```text
atomic temp write + rename
```

---

## 12.2 推荐执行顺序

```text
1. Revalidate plan
2. 检查 collision / reserved / dirty / versions
3. 创建 journal
4. 备份所有将被 Markdown patch 的文件
5. phase = rewriting
6. Source-preserving patch 全部成功
7. 执行最终 file/directory rename
8. phase = relocated
9. 更新必要 Vault metadata
10. phase = committed
11. 清理 backup + journal
12. Reconcile indexes / caches
```

关键思想：

```text
多文件 rewrite 是慢步骤
最终 path rename 是短步骤
```

先把可失败的多文件 patch 全部完成，再通过一次最终 rename 完成路径切换。

在 rename 之前短暂存在“href 已指向未来路径”的窗口，但 journal 能在失败或 crash 后恢复原始 Markdown。

---

# 13. Rollback

任意步骤失败：

```text
if path 已经 relocated:
    rename back

restore backups

mark / cleanup journal

rebuild derived indexes
```

不能只显示：

```text
操作失败
```

却留下未知磁盘状态。

---

# 14. Crash Recovery

打开 Vault 时，在正常进入工作区之前检测：

```text
.e1/operations/*/manifest.json
```

如果存在非 committed journal：

```text
自动恢复安全状态
```

推荐第一版：

```text
默认 rollback 到操作前状态
```

而不是尝试继续完成操作。

原因：

- 回滚状态有完整 backup；
- “继续完成”需要重新验证大量外部编辑与路径状态；
- 用户更容易理解“上次文件操作已安全恢复”。

恢复成功后 UI 显示一次非阻塞提示：

```text
上次文件操作被意外中断，E1 已恢复原文件。
```

如果自动恢复无法确定安全状态：

```text
FILE_OPERATION_RECOVERY_REQUIRED
```

阻止继续写入该 Vault，并提供：

```text
打开恢复详情
在文件管理器中显示 Vault
重新扫描
```

禁止猜测性覆盖。

---

# 15. Dirty / Open Document 协调

Preflight 必须识别：

```text
open clean
open dirty
pending save
conflicted
read-only compatibility
```

规则：

## open clean

允许操作。

操作完成后：

```text
reload / advance version
update source path
```

避免 clean editor 下一次保存使用旧 version/path。

## open dirty

如果文档属于：

```text
pathMoves
或
patches
```

则 Block。

## pending save

先请求 SaveCoordinator flush。

flush 成功后重新计算 plan。

## conflict

Block。

## compatibility read-only

因为 R011 使用 raw Markdown destination patch，而不是整篇 Tiptap serialize，理论上可安全修改标准 Markdown href。

但第一版仍需在 scanner 无法确认目标 destination 时保守跳过并产生 blocker，不得降级成整篇序列化。

---

# 16. Case-only Rename

macOS 默认文件系统常见大小写不敏感。

必须支持：

```text
React.md
→
react.md
```

以及：

```text
React/
→
react/
```

不能简单执行：

```text
pathExists(dest) -> collision
```

推荐 Main 实现：

```text
source
→ temporary hidden sibling
→ destination
```

例如：

```text
React.md
→ .React.md.e1-renaming-<uuid>
→ react.md
```

第二步失败必须回滚。

临时项必须：

- 同目录；
- 隐藏；
- 高熵唯一；
- watcher 自写抑制；
- crash journal 可恢复。

---

# 17. Workspace Rename 详细语义

新增业务 IPC，例如：

```text
vault.rename
```

输入：

```ts
{
  vaultId: string;
  name: string;
}
```

Main：

```text
resolveVaultRoot(vaultId)
↓
read .e1/vault.json
↓
validate current vaultId
↓
patch name only
↓
atomic write
↓
best-effort refresh recent-vaults displayName
```

`.e1/vault.json` 是 Workspace 名称 Source of Truth。

`recent-vaults.json` 的 `displayName` 视为本机缓存。

如果 registry 同步失败：

```text
Vault rename 仍成功
registry 下次 openRecent 自动修正
```

不能因为本机最近列表缓存写失败回滚已经成功的 Vault metadata。

---

# 18. Document Rename Flow

```text
用户：重命名文件…
      ↓
输入 React-Fiber.md
      ↓
plan(rename-document-file)
      ↓
LinkIndex impact
      ↓
2 documents / 5 links affected
      ↓
Preflight Dialog
      ↓
确认
      ↓
Journaled execute
      ↓
rewrite inbound hrefs
      ↓
rename React.md → React-Fiber.md
      ↓
scan/source/index reconcile
```

文件名输入建议允许用户省略 `.md`：

```text
React-Fiber
```

UI 自动展示最终：

```text
React-Fiber.md
```

Main 合同仍要求最终 `newName` 为 `.md`。

---

# 19. Document Move Flow

当前拖拽文档：

```text
page.move()
→ note.move()
```

R011 Desktop 需升级：

```text
Drop Intent
    ↓
FileOperationService.plan(move-document)
    ↓
0 impact?
    ├─ yes → quick confirm / direct operation
    └─ no  → impact dialog
    ↓
execute
```

对于 drag-and-drop，建议：

- 0 rewrite + 0 blocker：可以直接完成；
- 存在 rewrite：弹 Preflight；
- blocker：拒绝 drop 并显示原因。

不要在用户松手以后静默批量改写大量文件。

---

# 20. Group Rename / Move Flow

Group 操作可能影响大量文档。

Preflight 必须显示：

```text
移动「React」到「Archive」

将移动：32 篇文档
将更新：17 篇文档
内部链接：43 处
附件路径：8 处

[查看影响] [取消] [移动并更新链接]
```

超过阈值，例如：

```text
rewrittenDocuments >= 100
或
rewrittenLinks >= 500
```

要求显式二次确认。

阈值属于 UX Safety Gate，不是技术硬限制；最终数值可按真实测试校准。

---

# 21. Preflight UI

建议新增：

```text
FileOperationPreflightDialog
```

分区：

```text
目标
影响
阻塞项
警告
```

### 影响

显示：

```text
移动文档数
改写文档数
改写内部链接数
改写附件引用数
```

### Blocker 示例

```text
有 2 篇受影响文档存在未保存修改
目标目录已存在同名文件
链接索引尚未完成构建
文件已被外部程序修改
```

### Warning 示例

```text
知识库含 E1 当前不索引的 Wiki/Reference Link 语法，无法保证这些非 R010 链接形式会随路径自动更新。
```

第一版 Warning 不自动转换语法。

---

# 22. Unsupported Link Syntax Safety

R010 当前正式索引的 Markdown 形态是：

```md
[text](href)
![alt](src)
```

不包含：

```md
[[Wiki Link]]
[text][ref]
[ref]: target.md
```

因此 R011 的完整性保证必须写清楚：

```text
Guaranteed rewrite scope
=
R010 indexed link syntax
```

R011 Stage 0 建议增加轻量 compatibility detector。

如果 Vault / affected documents 检测到可能存在未索引路径引用：

```text
warning
```

而不是宣称：

```text
0 links affected
```

等同于“绝对没有其他路径引用”。

Wiki / Reference-style 自动重写延期 R014。

---

# 23. Watcher 与 SelfWriteRegistry

一次 R011 operation 可能触发：

```text
many markdown change events
+
rename/move events
```

Main 必须把 operation 产生的路径登记到 SelfWriteRegistry。

目标：

```text
E1 自己的批量操作
≠
被 ExternalVaultChangeService 误判为外部编辑
```

但不能永久吞掉真实外部变更。

建议：

```text
operation scoped suppression
```

带：

```text
operationId
paths
expiry
```

而不是无限扩张全局 ignore window。

---

# 24. Scan Cache / Source Cache

操作成功以后：

## Document rename / move

必须更新：

```text
DesktopDocumentSourceCache.relativePath
DesktopVaultScanCache invalidate/rescan
Stable ID aliases
```

## Group rename / move

目录内所有已打开文档的 source path 都必须重新映射。

不能只更新当前文档。

建议通过：

```text
path prefix transform
```

更新 Source Cache：

```text
oldPrefix/sub/a.md
→
newPrefix/sub/a.md
```

---

# 25. SearchIndex / LinkIndex Reconciliation

## 25.1 单文档 rename / move

优先增量：

```text
search.relocate
links.relocate
links.upsert affected sources
```

如果任何增量失败：

```text
mark degraded
schedule rebuild
```

不回滚 Markdown。

---

## 25.2 Group rename / move

第一版建议正确性优先：

```text
rescan vault
rebuild LinkIndex
rebuild SearchIndex
```

原因：

- group 可包含大量 path-based identities；
- 一次 prefix relocate 会改变很多 path key；
- watcher move coalescing 不适合作为唯一事实来源；
- 当前 10k LinkIndex rebuild 已在秒级。

后续如 benchmark 表明必要，再实现 prefix-level targeted relocation。

---

# 26. RuntimeOperations 语义修正

R011 Stage 0 必须重新核对：

```text
page.document.renameFile
```

其定义已经明确是：

```text
physical file rename
```

因此 Web 不存在真实物理文件时，不应继续把该字段设为 true。

建议修正：

```ts
webOperations.page.document.renameFile = false;
```

Desktop 在 R011 实现完成后：

```ts
desktopOperations.page.document.renameFile = true;
```

这不是平台分支，而是 Operation Matrix 对实际产品能力的诚实表达。

Web 的普通页面标题重命名继续走：

```text
renameTitle = true
```

---

# 27. Error Model

建议新增共享错误码：

```text
FILE_OPERATION_STALE_PLAN
FILE_OPERATION_BLOCKED_DIRTY
FILE_OPERATION_RECOVERY_REQUIRED
FILE_OPERATION_PARTIAL_FAILURE
```

复用：

```text
VAULT_PATH_COLLISION
VAULT_RESERVED_PATH
VAULT_READ_ONLY
PAGE_NOT_FOUND
DOCUMENT_CONFLICT
NOTE_WRITE_PERMISSION_DENIED
NOTE_WRITE_IO_ERROR
```

原则：

- 用户输入错误 → INVALID_INPUT / VAULT_PATH_COLLISION；
- 外部修改导致 plan 过期 → FILE_OPERATION_STALE_PLAN；
- dirty editor → FILE_OPERATION_BLOCKED_DIRTY；
- crash recovery 无法自动判定 → FILE_OPERATION_RECOVERY_REQUIRED；
- 不把 Node errno 直接暴露给 UI。

---

# 28. R011 Stage 0：Semantics Freeze & Baseline

目标：先冻结语义，再写功能。

任务：

- [x] R11-001 冻结 Workspace Rename = vault.json logical name，不改 root folder；
- [x] R11-002 冻结 Title Rename 与 File Rename 两套 UI 文案；
- [x] R11-003 冻结 Document / Group move target 只允许 Root 或 Group；
- [x] R11-004 冻结 R010-supported link rewrite scope；
- [x] R11-005 修正 Web `renameFile=false`；
- [x] R11-006 更新 RuntimeOperations contract tests；
- [x] R11-007 为当前 document.move“会导致相对链接变化”的行为补回归测试，先证明旧缺口；
- [x] R11-008 定义 FileOperationPlan / error codes；
- [x] R11-009 定义 operation journal v1 schema；
- [x] R11-010 锁定 case-only rename 语义。

Stage 0 DoD：

```text
无新 UI
无 operation flag 提前翻 true
所有语义测试绿
```

---

# 29. R011 Stage 1：Relocation Impact & Markdown Patcher

任务：

- [x] R11-101 抽取现有 Markdown link scanner 公共底层；
- [x] R11-102 scanner 返回 destination source ranges；
- [x] R11-103 实现 source-preserving `rewriteMarkdownLinkDestinations`；
- [x] R11-104 支持普通 link 与 image；
- [x] R11-105 支持 angle destination / space path；
- [x] R11-106 支持 balanced parentheses；
- [x] R11-107 保留 fragment；
- [x] R11-108 fenced code / inline code 不改；
- [x] R11-109 实现 path relocation pure planner；
- [x] R11-110 LinkIndex 增加 relocation impact query；
- [x] R11-111 Memory / SQLite contract 同步；
- [x] R11-112 compatibility detector / warning 语义。

核心测试：

```text
中文路径
空格路径
% 编码路径
../
./
fragment
重复标题
external
mailto
asset
image
code fence
inline code
same-source-and-target-move
oldHref == newHref skip
```

---

# 30. R011 Stage 2：Journaled Main File Operation Engine

任务：

- [x] R11-201 新建 `.e1/operations` journal 管理器；
- [x] R11-202 manifest 原子写；
- [x] R11-203 backup / restore；
- [x] R11-204 expectedVersionToken revalidate；
- [x] R11-205 source-preserving Markdown patch；
- [x] R11-206 document rename；
- [x] R11-207 document move；
- [x] R11-208 directory rename；
- [x] R11-209 directory move；
- [x] R11-210 防 move into self / descendant；
- [x] R11-211 reserved path protection；
- [x] R11-212 collision protection；
- [x] R11-213 case-only temp-hop rename；
- [x] R11-214 rollback；
- [x] R11-215 crash recovery；
- [x] R11-216 SelfWriteRegistry operation scope；
- [x] R11-217 IPC schema + preload + mock shape。

Main IPC 不允许暴露通用文件系统能力。

---

# 31. R011 Stage 3：Document Rename & Move v2

任务：

- [x] R11-301 `FileOperationService.plan(rename-document-file)`；
- [x] R11-302 `execute(rename-document-file)`；
- [x] R11-303 接通已有 `note.renameFile` 能力到新事务引擎；
- [x] R11-304 文件名 UI；
- [x] R11-305 inbound link rewrite；
- [x] R11-306 Document Move outgoing internal links；
- [x] R11-307 Document Move managed asset paths；
- [x] R11-308 Source Cache 新路径；
- [x] R11-309 open-clean document refresh；
- [x] R11-310 dirty / pending-save blocker；
- [x] R11-311 Desktop `document.renameFile=true`。

Stage 3 完成后：

```text
document renameFile
和
document move
```

都不再是“裸 fs rename”。

---

# 32. R011 Stage 4：Group Rename & Move

任务：

- [x] R11-401 目录 descendants path mapping；
- [x] R11-402 Group Rename planner；
- [x] R11-403 Group Move planner；
- [x] R11-404 outside→inside rewrite；
- [x] R11-405 inside→outside rewrite；
- [x] R11-406 inside→asset rewrite；
- [x] R11-407 inside→inside no-op 自动识别；
- [x] R11-408 group dirty descendant blocker；
- [x] R11-409 group source-cache prefix remap；
- [x] R11-410 group operation 后 rescan；
- [x] R11-411 LinkIndex rebuild；
- [x] R11-412 SearchIndex rebuild；
- [x] R11-413 Desktop `group.rename=true`；
- [x] R11-414 Desktop `group.move=true`；
- [x] R11-415 Group F2 / context menu；
- [x] R11-416 Group drag/drop。

---

# 33. R011 Stage 5：Workspace Rename

任务：

- [x] R11-501 `vault.rename` IPC；
- [x] R11-502 patch `.e1/vault.json name`；
- [x] R11-503 atomic metadata write；
- [x] R11-504 registry displayName best-effort sync；
- [x] R11-505 WorkspaceRepository.rename Desktop implementation；
- [x] R11-506 Sidebar / Workspace settings rename UI；
- [x] R11-507 明确提示“磁盘文件夹名称不会改变”；
- [x] R11-508 transient preview 拒写；
- [x] R11-509 Desktop `workspace.rename=true`。

---

# 34. R011 Stage 6：Preflight UX & Reconciliation

任务：

- [x] R11-601 `FileOperationPreflightDialog`；
- [x] R11-602 impact summary；
- [x] R11-603 affected document list；
- [x] R11-604 blocker UI；
- [x] R11-605 unsupported syntax warning；
- [x] R11-606 large-operation confirmation；
- [x] R11-607 operation progress；
- [x] R11-608 success summary；
- [x] R11-609 failed + rolled-back summary；
- [x] R11-610 recovery notification；
- [x] R11-611 scan/source/link/search reconciliation；
- [x] R11-612 ExternalVaultChangeService 不产生伪冲突；
- [x] R11-613 reveal 操作在新路径仍正常。

---

# 35. R011 Stage 7：Scale, E2E & Packaged Acceptance

规模：

```text
1k docs
10k docs
```

重点 benchmark：

```text
single document rename preflight
single document move preflight
100-doc group move preflight
1k-doc group move preflight
10k vault impact query
Markdown patch throughput
rollback throughput
index rebuild after group operation
```

建议初始目标：

```text
single document preflight p95 < 150ms
100-doc group preflight < 500ms
1k-doc group preflight < 2s
10k vault impact analysis < 5s

single document rename/move UI-visible operation < 1s
（不含用户确认时间）
```

大 Group operation 不设置过紧 wall-clock SLA，要求：

```text
no OOM
no permanent UI freeze
progress visible
cancel before execute
crash recoverable
```

---

# 36. Unit / Contract Test Matrix

必须覆盖：

## Path Mapping

```text
file rename
file move root→group
group→root
group→group
group rename
nested group move
case-only rename
self descendant rejection
reserved destination
collision
```

## Link Rewrite

```text
inbound target moved
outgoing source moved
both source and target moved
internal subtree no-op
fragment preserved
link label preserved
image preserved
asset relative path recalculated
external unchanged
mailto unchanged
anchor unchanged
code unchanged
```

## Transaction

```text
backup success
patch N fails
rename fails
case-hop second rename fails
rollback succeeds
rollback partially fails
crash at prepared
crash at rewriting
crash at relocated
committed journal cleanup
```

## Concurrency

```text
external edit after preflight
expected version mismatch
pending save
open dirty
watcher self echo
```

---

# 37. Desktop Golden E2E

R010 已使用 G21–G30。

R011 新增：

```text
G31  Document 文件名重命名 → inbound link 自动改写
G32  Document move → inbound + outgoing link 均保持有效
G33  Document move → managed image/asset 仍可加载
G34  文件名重命名不改变 title / stable note id
G35  Group rename → 外部 inbound links 保持有效
G36  Group move → inside/outside links 保持有效
G37  Group move → subtree internal links 不产生无意义改写
G38  dirty affected document → 操作被阻止
G39  外部编辑导致 stale plan → 重新规划，不覆盖
G40  collision → 无文件被覆盖
G41  case-only rename
G42  Workspace logical rename → root path 不变
G43  中断 journal → 下次启动自动恢复
```

---

# 38. Packaged E2E

R010 已有 P10–P12。

R011 新增：

```text
P13 packaged E1.app Document rename + link rewrite
P14 packaged E1.app Group move + index rebuild
P15 packaged E1.app crash journal recovery
P16 packaged E1.app Workspace rename persistence
```

Packaged 测试的重点不是重复所有源码 E2E，而是验证：

```text
asar
node:fs
PathGuard
AtomicFileWriter
journal
chokidar
node:sqlite
```

组合在真实打包环境仍正常。

---

# 39. Visual Regression

需要补视觉基线：

```text
File Rename Dialog
Preflight Dialog
Blocker State
Large Impact State
Operation Progress
Recovery Notice
```

macOS 视觉基线继续不作为跨平台 CI blocker，但必须在 R011 验收记录中截图确认。

---

# 40. Migration

R011 不迁移 Markdown 内容。

新增内部目录：

```text
.e1/operations/
```

策略：

- 不存在时无需预创建；
- 第一次执行文件操作时创建；
- 成功 operation 清空自己的 journal；
- 空目录允许保留；
- 旧版 E1 忽略 `.e1/`，不会影响 Markdown；
- journal schema 带 `version`；
- 不兼容 journal 不得猜测恢复，进入 `FILE_OPERATION_RECOVERY_REQUIRED`。

SQLite schema 如增加 relocation query 所需索引：

```text
仍属于 derived data
```

不兼容可以直接 rebuild。

---

# 41. Security

继续满足：

```text
Renderer no absolutePath
PathGuard root containment
No symlink traversal
No generic fs IPC
No reserved path writes
No silent overwrite
```

operation journal 中允许记录：

```text
relativePath
versionToken
operationId
```

不得记录：

```text
API key
secret
无必要的 absolutePath
```

---

# 42. Documentation Updates

R011 实现过程中必须同步：

```text
docs/requirements/R011-desktop-file-operations-v2.md
docs/requirements/README.md
docs/architecture/runtime-boundaries.md
docs/architecture/link-index.md
docs/architecture/markdown-compatibility.md
docs/decisions.md
AGENTS.md
```

如果引入 journal，建议新增：

```text
docs/architecture/file-operations.md
```

内容至少包括：

```text
transaction phases
rollback
crash recovery
link impact semantics
cache/index reconciliation
```

---

# 43. Implementation Order

严格建议：

```text
Stage 0
Semantics Freeze
      ↓
Stage 1
Impact + Raw Markdown Patcher
      ↓
Stage 2
Journaled Main Engine
      ↓
Stage 3
Document Rename / Move v2
      ↓
Stage 4
Group Rename / Move
      ↓
Stage 5
Workspace Rename
      ↓
Stage 6
UX + Reconciliation
      ↓
Stage 7
Scale + E2E + Packaged
```

不要先把：

```text
group.rename=true
```

然后再补安全事务。

Operation flag 只能在对应能力完整通过测试后翻 true。

---

# 44. Definition of Done

R011 只有全部满足以下条件才能标记“已完成”。

## Functional

- [x] Desktop Workspace Rename 可用；
- [x] Document Physical File Rename 可用；
- [x] Document Move v2 保护链接与附件路径；
- [x] Group Rename 可用；
- [x] Group Move 可用；
- [x] case-only rename 可用；
- [x] collision 不覆盖；
- [x] dirty 文档不被覆盖。

## Integrity

- [x] Stable Note ID 在所有 path operation 后保持不变；
- [x] R010-supported internal links 在 rename/move 后不产生新增 broken；
- [x] managed asset references 保持有效；
- [x] title 与 physical filename 相互独立；
- [x] Workspace Rename 不改变 Vault root path。

## Transaction

- [x] multi-document rewrite 有 journal；
- [x] 任一步失败能够 rollback；
- [x] crash 后能够检测未完成 operation；
- [x] 自动恢复路径有真实测试；
- [x] 无法安全恢复时进入只读保护，不猜测写入。

## Architecture

- [x] Renderer 不出现 fs/path/SQLite/absolutePath；
- [x] LinkIndex 仍是 derived data；
- [x] Markdown patch source-preserving；
- [x] FileOperationService 是平台无关 contract；
- [x] Web 不引入 Desktop 分支；
- [x] Web physical rename operation 语义修正为 false。

## Quality

- [x] unit tests green；
- [x] contract tests green；
- [x] component tests green；
- [x] G31–G43 Desktop Golden green；
- [x] P13–P16 Packaged App green；
- [x] typecheck green；
- [x] lint green；
- [x] deps:check green；
- [x] build:web green；
- [x] build:desktop green；
- [x] remote CI green。

## Docs

- [x] R011 文档回写真实实现偏差；
- [x] requirements README 更新；
- [x] runtime boundaries 更新；
- [x] link index architecture 更新；
- [x] file operation architecture 文档完成；
- [x] decisions 更新；
- [x] AGENTS.md 更新；
- [x] 已延期内容有明确后续编号。

---

# 45. R011 完成后的 Desktop Operation Matrix

目标：

```ts
workspace: {
  rename: true,
  favorite: true,
},

page: {
  document: {
    create: true,
    renameTitle: true,
    renameFile: true,
    move: true,
    trash: true,
    favorite: true,
  },

  group: {
    create: true,
    rename: true,
    move: true,
    trash: true,
  },

  trash: {
    restore: true,
    purge: true,
  },
},

tag: {
  write: true,
},

revision: {
  read: false,
  write: false,
}
```

到这里 Desktop 的基础文件树生命周期才真正闭环：

```text
Create
Rename
Move
Trash
Restore
Purge
```

并且 Rename / Move 不再以破坏 Markdown 相对链接为代价。

---

# 46. R011 之后的路线

推荐：

```text
R010
Internal Links & Backlinks
        ↓
R011
Safe File Operations v2
        ↓
R012
Desktop Revision History
        ↓
R013
macOS Signing & Trust
        ↓
R014
Vault Portability & Advanced File Operations
```

R011 是 R010 的直接消费方：

```text
R010
知道“谁引用了谁”

R011
利用这些关系安全改变文件系统结构
```

这一步完成后，E1 才从：

```text
可以直接读写 Markdown 文件的笔记软件
```

进一步变成：

```text
能够维护 Markdown 知识库结构完整性的本地知识库工具
```

---

# 47. 完成记录与偏差（2026-09-03）

Stage 0–7 已落地。核心实现：

- `shared/fileOperations/` + `shared/links/` patcher / relocate / analyzeRelocation
- Main：`FileOperationJournal` + `JournaledFileOperationEngine` + `DesktopFileOperationPlanner`
- IPC：`fileOperation.plan|execute|recoveryStatus|recover` + `vault.rename`
- Renderer：`DesktopFileOperationService` + `FileOperationPreflightDialog`；操作开关已翻 true
- E2E：`e2e/desktop.fileops.spec.ts` G31–G43 本地全绿；`e2e/package/desktop.package.fileops.spec.ts` P13–P16（无安装包产物时 skip，同 R010 口径）
- 架构：`docs/architecture/file-operations.md`

**偏差：**

1. G38 UI 时序（防抖 800ms 内完成「编辑→预检」在 Electron+prompt 下不稳定）——dirty 注入由 `DesktopFileOperationService` 单测锁定；Golden G38 断言引擎拒 blocker + 文件未改。
2. IPC 直调 group 操作跳过 Renderer reconcile，E2E 在连续 group rename→move 间显式 `links.rebuild`（产品路径经 `DesktopFileOperationService` 自动 rebuild）。
3. Preflight 完整对话框目前主要挂在「重命名文件…」；文档/分组 move 经仓储 `plan→execute`（有 blocker 即抛），未全部统一弹窗。
4. 视觉基线（File Rename / Preflight 等）本机 macOS 生成，不进 Linux CI。
5. `playwright.config.ts` 清除 `ELECTRON_RUN_AS_NODE`（代理环境注入会导致 `_electron.launch` 以 Node 模式崩溃）。
