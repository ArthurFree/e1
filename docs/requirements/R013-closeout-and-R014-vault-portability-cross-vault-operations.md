# R013 收口验收与 R014 Vault Portability & Cross-Vault Operations

> 版本：0.2  
> 状态：历史规划（Part A：R013 Stage 7 仍待真实证书，不得假完成；Part B：R014 已拆出独立需求并落地，见 `R014-vault-portability-cross-vault-operations.md`）  
> 更新时间：2026-09-10  
> 当前基线：`ba739ed973d292d858fecf7a3544496540ea4dcd`  
> 目标平台：macOS Desktop  
> 前置需求：R010、R011、R011.1、R012、R013  
> 下一阶段：R014 独立需求文件；R013 Stage 7 仍为运营步骤  

---

# Part A：R013 验收与收口

## 1. 当前状态

R013 的源码与 CI 基础已经完成，当前准确状态应为：

```text
R013 Stage 0–6  ✅
R013 Stage 7    ⏳
```

当前 `main`：

```text
ba739ed973d292d858fecf7a3544496540ea4dcd

feat(R013):
macOS Signing & Trust——正式 Release 强制 Developer ID + 公证
```

已经完成：

```text
Developer ID release pipeline
Hardened Runtime
Entitlements
Signing preflight
Notarization automation
Stapling / Gatekeeper verification scripts
Signed packaged E2E gate
macOS signed-package auto-update gate
Signing credential lifecycle isolation
Unsigned local QA / signed Release split
```

但尚未发生：

```text
真实 Developer ID 签名产物
真实 Apple Notarization Accepted
真实 stapling / Gatekeeper 验证
真实 P21–P26 signed packaged QA
第一份 GitHub Release
浏览器下载后的 quarantine QA
signed vA → signed vB 自动升级验证
```

因此：

> R013 的工程实现已经完成，但严格按照 DoD，必须完成一次真实 Stage 7 Release 后才能标记为“已完成”。

---

## 2. 已确认实现效果

### 2.1 正式 Release 不再允许 unsigned fallback

正式 Release：

```text
missing signing secret
→ fail

signing failure
→ fail

notarization rejected
→ fail

stapling failure
→ fail

Gatekeeper rejected
→ fail
```

本地：

```text
npm run package:desktop
→ unsigned QA allowed
```

正式：

```text
E1_RELEASE_SIGNING=1
→ forceCodeSigning
→ notarize
```

### 2.2 Hardened Runtime

正式 macOS build 已配置：

```yaml
mac:
  hardenedRuntime: true
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.inherit.plist
```

### 2.3 Credential 生命周期

```text
GitHub Secrets
↓
Temporary Keychain / temp p12 / temp p8
↓
electron-builder
↓
cleanup
↓
clear CSC_* environment
```

不得进入：

```text
Git
artifact
runtime app
CI log
```

### 2.4 Auto Update

```text
darwin
+
codeSigned == true
→ canAutoInstall=true
```

本地 unsigned 包：

```text
canAutoInstall=false
```

---

## 3. R013 Stage 7 Closeout

R013 不需要继续增加新的架构代码。

剩余工作：

```text
配置 GitHub signing secrets
↓
bump package.json version
↓
push vX.Y.Z
↓
Developer ID signing
↓
Apple notarization
↓
Accepted
↓
stapling
↓
Gatekeeper
↓
P21–P26
↓
GitHub Release
↓
browser download QA
↓
signed vA → vB update QA
```

---

## 4. R013 Stage 7 Definition of Done

- [ ] Developer ID Application 真实签名成功；
- [ ] Main App 与所有 nested code 签名有效；
- [ ] Hardened Runtime 真实生效；
- [ ] TeamIdentifier 正确；
- [ ] notary submission 成功；
- [ ] status = `Accepted`；
- [ ] `stapler staple` 成功；
- [ ] `stapler validate` 成功；
- [ ] `spctl --assess` accepted；
- [ ] DMG signed / notarized；
- [ ] ZIP signed / notarized；
- [ ] latest-mac.yml / blockmap 正确；
- [ ] SHA256SUMS 针对最终产物生成；
- [ ] P01–P20 在 signed/notarized app 全绿；
- [ ] P21–P26 全绿；
- [ ] 第一份 GitHub Release 创建；
- [ ] 浏览器下载真实 DMG 后 quarantine + Gatekeeper 首启通过；
- [ ] signed vA → signed vB 自动升级通过；
- [ ] safeStorage 跨版本保持。

---

# Part B：R014 Vault Portability & Cross-Vault Operations

## 5. 目标

R011 已解决：

```text
一个 Vault 内
安全 Rename / Move
```

R014 继续解决：

```text
Vault 根目录
+
多个 Vault
+
跨 Vault 数据迁移
```

正式名称：

```text
R014：Vault Portability & Cross-Vault Operations
```

中文：

```text
知识库迁移、跨库文件操作与高级链接兼容
```

核心路线：

```text
Single-Vault Safe Operations
        ↓
Vault Relocation
        ↓
Cross-Vault Copy
        ↓
Cross-Vault Move
        ↓
Advanced Markdown Link Compatibility
```

---

## 6. R014 范围

包含：

```text
Missing Vault Relocate
Physical Vault Root Rename
Physical Vault Root Move
Cross-volume Vault Relocation
Cross-Vault Document Copy
Cross-Vault Group Copy
Cross-Vault Document Move
Cross-Vault Group Move
Managed Asset Transfer
Revision Transfer
Boundary Link Analysis
Reference-style Markdown Link Support
Crash-safe Transfer Journal
```

不包含：

```text
cloud sync
multi-user collaboration
remote vault
WebDAV
Dropbox / iCloud API integration
Git sync
real-time conflict merge
Wiki Link title resolution
Obsidian vault full compatibility
block-level links
heading refactor
Windows/Linux QA
```

---

## 7. 核心语义冻结

### PORT-01：Workspace Rename ≠ Vault Relocation

现有：

```text
workspace.rename
```

只修改：

```text
.e1/vault.json name
```

R014 新增的 Vault Relocation 才改变 Vault Root 的物理位置。

### PORT-02：Cross-Vault Copy 创建新知识对象

```text
Vault A / Note AAA
↓ copy
Vault B / Note BBB
```

必须：

```text
new stable note id
```

### PORT-03：Cross-Vault Move 保持 Stable ID

Move 表示同一知识对象迁移：

```text
stable note id preserved
```

### PORT-04：Copy 默认不复制 Revision History

复制后目标文档从当前正文开始自己的历史。

### PORT-05：Move 必须迁移 Revision History

保持 revision id、时间、reason、raw Markdown body。

### PORT-06：Canonical Link 继续使用普通 Markdown Relative Link

继续：

```md
[Target](../Target.md)
```

不引入 `e1://`，也不把 canonical format 改为 Wiki Link。

---

## 8. Missing Vault Relocate

当前 Vault Registry 旧目录不可访问时只会：

```text
accessible=false
```

R014 增加：

```text
Relocate Missing Vault…
```

流程：

```text
recent vault inaccessible
↓
user choose directory
↓
read .e1/vault.json
↓
vaultId comparison
↓
match
↓
update registry absolutePath
↓
reopen
```

必须满足：

```text
selected vaultId == recent vaultId
```

否则拒绝。

---

## 9. Physical Vault Root Rename / Move

支持：

```text
~/Documents/MyVault
↓
~/Documents/Frontend
```

和：

```text
~/Documents/MyVault
↓
~/Notes/MyVault
```

需要同步：

```text
VaultRegistry.absolutePath
Watcher root
Vault root resolver
Search DB handle
Link DB handle
SourceCache
Open document path context
Recent vault state
```

---

## 10. Vault Relocation Journal

R011 Journal 位于 Vault 内，不适合整个 Vault 搬迁。

R014 新增：

```text
Electron userData/
vault-relocations/
```

建议：

```ts
interface VaultRelocationJournal {
  version: 1;
  operationId: string;
  vaultId: string;

  sourcePath: string;
  destinationPath: string;

  strategy:
    | "rename"
    | "copy-verify-delete";

  phase:
    | "prepared"
    | "copying"
    | "verifying"
    | "destination-ready"
    | "registry-updated"
    | "source-removing"
    | "committed"
    | "recovery-required";

  createdAt: string;
}
```

---

## 11. Same-filesystem Relocation

优先：

```text
fs.rename(sourceRoot, destinationRoot)
```

成功后：

```text
update VaultRegistry
↓
restart Watcher
↓
invalidate caches
↓
reopen Link/Search
```

---

## 12. Cross-filesystem Relocation

遇到：

```text
EXDEV
```

改走：

```text
copy source → destination.tmp
↓
verify
↓
activate destination
↓
update registry
↓
reopen destination
↓
remove source
```

核心不变量：

> Source 在 Destination 被完整验证之前永不删除。

---

## 13. Relocation Verification

至少验证：

```text
vault.json
note count
managed asset count
revision structure
critical .e1 metadata
file sizes
```

用户数据文件建议 SHA-256 校验。

Derived Data：

```text
SearchIndex
LinkIndex
```

允许不复制，目标端 rebuild。

---

## 14. Cross-Vault Copy

支持：

```text
single document
group subtree
```

流程：

```text
Source Selection
↓
Impact Analysis
↓
New Stable ID Mapping
↓
Asset Inventory
↓
Link Rewrite
↓
Destination Collision Plan
↓
Copy
↓
Verify
↓
Destination Index Reconcile
```

---

## 15. Copy Stable ID Mapping

例如：

```text
Vault A
A id=AAA
B id=BBB
```

一起复制：

```text
AAA → NEW_A
BBB → NEW_B
```

内部链接在目标继续指向新对象。

磁盘仍使用普通相对 Markdown 链接。

---

## 16. Cross-Vault Move

推荐：

```text
Copy
↓
Verify
↓
Transfer Revision
↓
Activate Destination
↓
Trash Source
```

第一版不永久删除 source。

---

## 17. Boundary Link Analysis

定义：

```text
Inside  = selected transfer set
Outside = selected set 之外
```

分类：

```text
Inside → Inside
Outside → Inside
Inside → Outside
```

### Inside → Inside

可安全迁移。

### Outside → Inside

Move 后源 Vault 会产生 broken link。

### Inside → Outside

Move 后目标 Vault 会产生 broken link。

---

## 18. Boundary Link Policy

### Copy

```text
boundary links
→ warning
```

### Move

```text
boundary links
→ blocker
```

只有：

```text
boundaryLinks == 0
```

才允许 Move。

原则：

> 不为了支持跨 Vault Move 而静默破坏知识图谱。

---

## 19. Managed Assets Transfer

迁移 Markdown 时扫描所有 managed assets。

例如：

```md
![diagram](../assets/diagram.png)
```

目标处理：

```text
asset hash
↓
destination lookup
```

同名同 SHA-256：

```text
reuse
```

同名不同内容：

```text
diagram.png
diagram (2).png
diagram (3).png
```

然后 source-preserving rewrite Markdown destination。

---

## 20. Revision Transfer

### Copy

```text
do not copy revisions
```

### Move

迁移 revision series，并保持 revision identity。

---

## 21. Trash / Restore Semantics

Cross-Vault Move 成功后：

```text
destination active
source → trash
```

如果用户恢复 source，可能形成两个同 stable ID 对象。

第一版建议：

```text
detect duplicate stable ID
↓
restore blocked
↓
ask user duplicate with new ID or cancel
```

不得静默产生双 stable identity。

---

## 22. Reference-style Markdown Links

第一批支持：

```md
[a][target]

[target]: ../Target.md
```

和：

```md
[a][]

[a]: ../Target.md
```

路径迁移只改 definition：

```diff
-[target]: ../Old/Target.md
+[target]: ../New/Target.md
```

继续 source-preserving。

---

## 23. Wiki Link Policy

R014 不做完整：

```text
[[React]]
```

title resolution。

因为当前架构已经冻结：

```text
resolve by path
never resolve by title
```

第一版：

```text
detect Wiki Link
→ unsupported syntax warning
```

不自动按 title 解析。

---

## 24. Architecture

```text
Shared UI
      ↓
VaultTransferService
      ↓
VaultTransferPlanner
├── Source Vault Scan
├── Destination Vault Scan
├── LinkIndex
├── Revision Store
├── Managed Assets
├── Dirty Document State
└── Path / Collision Policy
      ↓
VaultTransferPlan
      ↓
Desktop IPC
      ↓
Main VaultTransferEngine
├── Source PathGuard
├── Destination PathGuard
├── Transfer Journal
├── Raw Markdown Patcher
├── Asset Copier
├── Revision Transfer
└── Atomic Writer
      ↓
Reconcile
├── Source Watcher
├── Destination Watcher
├── SourceCache
├── LinkIndex
└── SearchIndex
```

---

## 25. Suggested App Service

```ts
interface VaultTransferService {
  plan(
    request: VaultTransferRequest
  ): Promise<VaultTransferPlan>;

  execute(
    plan: VaultTransferPlan
  ): Promise<VaultTransferResult>;

  getRecoveryStatus(
    operationId: string
  ): Promise<VaultTransferRecoveryStatus>;

  recover(
    operationId: string
  ): Promise<VaultTransferRecoveryResult>;
}
```

---

## 26. Transfer Plan

```ts
interface VaultTransferPlan {
  operationId: string;

  kind:
    | "relocate-vault"
    | "copy-document"
    | "copy-group"
    | "move-document"
    | "move-group";

  sourceVaultId: string;
  destinationVaultId?: string;

  notes: Array<{
    sourcePath: string;
    destinationPath: string;
    sourceStableId: string | null;
    destinationStableId: string;
  }>;

  assets: AssetTransferPlan[];
  revisions: RevisionTransferPlan[];

  linkImpacts: {
    internal: number;
    inboundBoundary: number;
    outboundBoundary: number;
  };

  blockers: TransferBlocker[];
  warnings: TransferWarning[];
}
```

---

## 27. Stale Plan Protection

Cross-Vault 操作同时验证 Source 和 Destination。

如果 Preflight 后出现：

```text
source document changed
destination path created
destination asset changed
destination vault relocated
```

执行必须：

```text
VAULT_TRANSFER_STALE_PLAN
```

重新 plan。

---

## 28. Dirty Document Policy

存在：

```text
dirty
pending save
conflict
```

则 operation blocked。

第一版不支持 force transfer dirty editor。

---

## 29. Collision Policy

Cross-Vault Copy 可确定性改名，但必须在 Preflight 明示。

Cross-Vault Move：

```text
collision = blocker
```

---

## 30. Crash Recovery

例如：

```text
copying
↓ crash
```

恢复：

```text
destination temp incomplete
→ cleanup
→ source unchanged
```

如果：

```text
destination activated
↓ crash
↓ source not trashed
```

恢复必须明确识别该状态，不得猜测删除 source。

---

# 31. R014 Stage 0 — Semantics Freeze

冻结：

```text
Vault Relocation semantics
Copy identity semantics
Move identity semantics
Revision transfer semantics
Boundary link policy
Asset collision policy
Reference link support scope
Recovery rules
```

Stage 0 不写真实文件。

---

# 32. R014 Stage 1 — Missing Vault Relocate

实现：

```text
recent Vault inaccessible
↓
Relocate…
↓
system directory picker
↓
vaultId verify
↓
registry update
↓
reopen
```

---

# 33. R014 Stage 2 — Physical Vault Relocation

支持：

```text
same filesystem rename
same filesystem move
cross filesystem copy-verify-delete
```

加入 userData-level relocation journal。

---

# 34. R014 Stage 3 — Cross-Vault Copy

实现：

```text
Document Copy
Group Copy
Stable ID remap
Managed Assets
Internal Link Rewriting
Destination Collision Planning
Destination Index Reconcile
```

---

# 35. R014 Stage 4 — Cross-Vault Move

基于 Copy engine：

```text
copy
↓
verify
↓
revision transfer
↓
destination activate
↓
source trash
```

启用 boundary link blocker。

---

# 36. R014 Stage 5 — Reference-style Link Support

升级 shared Markdown scanner：

```text
inline destination
+
reference definition destination
```

同步：

```text
LinkIndex Memory
LinkIndex SQLite
File Operation Patcher
Vault Transfer Planner
```

---

# 37. R014 Stage 6 — UX & Recovery

增加入口：

```text
Move knowledge base location…
Relocate missing knowledge base…
Copy to another knowledge base…
Move to another knowledge base…
```

统一 Preflight：

```text
Documents
Assets
Revisions
Links rewritten
Boundary links
Collisions
Warnings
Blockers
```

---

# 38. R014 Stage 7 — Scale / E2E / Packaged

Desktop Golden：

```text
G57  missing Vault → relocate → reopen
G58  physical Vault root rename
G59  cross-volume Vault relocation
G60  copy document → new stable ID
G61  copy group → internal links preserved
G62  copy → managed assets preserved
G63  move document → stable ID preserved
G64  move group → revisions preserved
G65  inbound boundary link blocks move
G66  outbound boundary link blocks move
G67  collision never overwrites
G68  stale source plan blocks
G69  destination changed after preflight blocks
G70  reference-style link rewrite
G71  interrupted transfer recovers
```

Packaged：

```text
P27 Vault relocation
P28 Cross-Vault Copy
P29 Cross-Vault Move + Revision
P30 Interrupted Transfer Recovery
```

---

## 39. Performance Targets

```text
Missing Vault relocate:
p95 < 300ms
```

```text
100-document Cross-Vault Copy preflight:
< 1s
```

```text
1k-document subtree preflight:
< 3s
```

10k Vault relocation：

```text
progress observable
cancel before activation
crash recoverable
```

---

## 40. Security Boundary

Renderer 不得获得：

```text
generic fs API
arbitrary absolute source path
arbitrary absolute destination path
```

目录选择由 Main 执行。

Renderer 只使用：

```text
vaultId
targetVaultId
operationId
relativePath
```

---

# 41. R014 Definition of Done

## Vault Relocation

- [ ] Missing Vault 可重新定位；
- [ ] vaultId mismatch 拒绝；
- [ ] Physical Vault Rename；
- [ ] Physical Vault Move；
- [ ] Cross-filesystem Move；
- [ ] Source 在 Destination verify 前不删除；
- [ ] VaultRegistry 正确更新；
- [ ] Watcher 正确重启；
- [ ] Link/Search 正确恢复。

## Cross-Vault Copy

- [ ] Document Copy；
- [ ] Group Copy；
- [ ] Copy 生成 new Stable IDs；
- [ ] Internal links preserved；
- [ ] Managed assets copied；
- [ ] Asset dedupe；
- [ ] Asset collision deterministic；
- [ ] Destination Link/Search reconcile。

## Cross-Vault Move

- [ ] Document Move；
- [ ] Group Move；
- [ ] Stable IDs preserved；
- [ ] Revision History preserved；
- [ ] Source goes to trash；
- [ ] boundary inbound link blocks move；
- [ ] boundary outbound link blocks move；
- [ ] no silent broken graph。

## Markdown Compatibility

- [ ] Reference-style link extraction；
- [ ] Reference definition rewrite；
- [ ] source-preserving；
- [ ] inline link 无回归；
- [ ] Wiki Link 不按 title 自动解析。

## Safety

- [ ] Source stale plan blocked；
- [ ] Destination stale plan blocked；
- [ ] Dirty document blocked；
- [ ] Collision never silently overwrites；
- [ ] Crash recovery；
- [ ] Main-only absolute path handling；
- [ ] Renderer no generic filesystem API。

## Quality

- [ ] Unit tests green；
- [ ] Contract tests green；
- [ ] G57–G71 green；
- [ ] P27–P30 green；
- [ ] typecheck green；
- [ ] lint green；
- [ ] deps:check green；
- [ ] build:web green；
- [ ] build:desktop green；
- [ ] latest remote CI green。

## Docs

- [ ] `docs/requirements/R014-vault-portability-cross-vault-operations.md`；
- [ ] requirements README；
- [ ] portable-vault architecture；
- [ ] file operation architecture；
- [ ] decisions；
- [ ] AGENTS；
- [ ] recovery semantics documented。

---

# 42. 推荐执行顺序

```text
R013 Stage 7
Real Developer ID Release
        ↓
R013 Closed
        ↓
R014 Stage 0
Semantics Freeze
        ↓
Stage 1
Missing Vault Relocate
        ↓
Stage 2
Physical Vault Relocation
        ↓
Stage 3
Cross-Vault Copy
        ↓
Stage 4
Cross-Vault Move
        ↓
Stage 5
Reference-style Link Compatibility
        ↓
Stage 6
UX / Recovery
        ↓
Stage 7
Scale / Packaged / Docs
```

---

# 43. 工程优先级

```text
1. Identity correctness
2. Source data safety
3. Boundary link correctness
4. Crash recovery
5. Revision preservation
6. Asset integrity
7. UI convenience
```

不要先开放 Cross-Vault Move，再补：

```text
Stable ID
Revision
Boundary Link
Recovery
```

这些语义必须先冻结。
