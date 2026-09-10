# R014：Vault Portability & Cross-Vault Operations

> 版本：1.0  
> 状态：实现中（Stage 0–6 产品能力已落地；R014.1 完整性收口已接线。packaged 真实产物与远端 Desktop Golden 全绿之前不得标「已完成」）  
> 更新时间：2026-09-10  
> 目标平台：macOS Desktop  
> 前置需求：R010、R011、R011.1、R012、R013（Stage 0–6）  
> 规划稿：[`R013-closeout-and-R014-vault-portability-cross-vault-operations.md`](./R013-closeout-and-R014-vault-portability-cross-vault-operations.md)（Part B 历史快照）

---

## 1. 文档目的

在单库安全文件操作（R011）与版本历史（R012）之上，让 Desktop Vault **可搬家、可跨库复制/移动**，并补齐引用式 Markdown 链接的提取与改写。

R013 Stage 7（真实 Developer ID + 公证 + 第一份 GitHub Release）**不在本需求范围内**，也不能用本需求的完成来假装 R013 已收口。

## 2. 核心不变量（已冻结）

| 编号 | 内容 |
| ---- | ---- |
| PORT-01 | `workspace.rename` 只改 `.e1/vault.json` 的 `name`，不等于 Vault 根目录搬迁 |
| PORT-02 | Cross-Vault Copy 生成 **新** stable note id |
| PORT-03 | Cross-Vault Move 保持 stable note id |
| PORT-04 | Copy **不**复制 revision history |
| PORT-05 | Move **必须**迁移 revision series（raw body 快照随行） |
| PORT-06 | Canonical 链接仍是普通 Markdown 相对路径；不引入 `e1://`，不按 title 解析 Wiki Link |

其它安全口径：

- Copy 边界链接 = warning；Move 入/出边界链接 = **blocker**（`boundaryLinks == 0` 才允许）。
- Copy 目标碰撞可确定性改名（Preflight 明示）；Move 碰撞 = blocker，永不覆盖。
- dirty / pending save / conflict → 禁止。
- 预检后源或目标变化 → `VAULT_TRANSFER_STALE_PLAN`。
- Renderer 只使用 `vaultId` / `relativePath` / `selectionToken` / `operationId`，不见绝对路径、无通用 fs API。
- 跨卷搬迁：Destination 校验完成前 **永不删除 Source**。
- 跨库 Move 后从源回收站恢复：若会与目标形成双 stable id → 拒绝（trash meta `crossVaultMovedToVaultId`）。

## 3. 阶段清单

| 阶段 | 内容 | 状态 |
| ---- | ---- | ---- |
| 0 | 语义冻结：`shared/vaultTransfer/`、操作矩阵字段、错误码 | 完成 |
| 1 | Missing Vault Relocate（选目录 + vaultId 比对 + 更新 Registry） | 完成 |
| 2 | Physical Vault Relocation + `userData/vault-relocations/` journal（rename / EXDEV copy-verify-delete） | 完成 |
| 3 | Cross-Vault Copy（新 id、内部链接、受管附件、碰撞改名） | 完成 |
| 4 | Cross-Vault Move（保 id、迁 revision、源进回收站、边界 blocker） | 完成 |
| 5 | 引用式 Markdown 链接提取与 source-preserving 改写 | 完成 |
| 6 | UX：Preflight / VaultPicker / 侧栏入口 / Recovery Bridge | 完成 |
| 7 | G57–G71 / P27–P30 / 文档 / 门禁 | 本地 G57–G71 全绿；P27–P30 已接线（无产物 skip）；远端 CI 待验证 |

## 4. 实现位置

- 共享契约：`shared/vaultTransfer/`、`shared/ipc/contracts.ts`（`vaultTransfer:*` 四通道）、`shared/errors.ts`
- Main：`electron/main/vaultTransfer/VaultRelocationEngine.ts`、`VaultTransferEngine.ts`、`electron/main/ipc/vaultTransfer.ts`
- Renderer：`src/application/vaultTransfer/VaultTransferService.ts`、`src/platform/desktop/DesktopVaultTransferService.ts`
- 操作矩阵：`workspace.relocate`、`page.document|group.copyToVault|moveToVault`（Web 全 false，Desktop 全 true）
- UI：`VaultTransferPreflightDialog`、`VaultPickerDialog`、`VaultTransferRecoveryBridge`、侧栏/首页/页面树入口
- 目录选择 E2E：`E1_SELECT_DIRECTORY=<abs>` 注入 Main `openDialog` stub，Renderer 仍只拿 token

## 5. 恢复语义

整库搬迁 journal 落在 **Electron userData**（`vault-relocations/`），不进 Vault 内——根目录本身会消失。

```text
phase = copying
  → 清 staging（`<dest>.e1-relocating`），不删源

phase = verifying | destination-ready
  → 目标已完整则可完成 registry 更新；源仍在则保留直到 committed

phase = recovery-required / 无法判定
  → 人工介入；绝不猜测删除源目录
```

跨库 Copy/Move **不写独立 journal 文件**（`VaultCopyMoveJournal` 类型预留）。安全依赖：先把目标写完（`wx` 不覆盖），Move 成功后再把源 **rename 进回收站**。中断时源仍在；目标可能留下部分新文件，不自动回滚以免误删用户原有内容。

启动时 Main `recoverRelocations` fire-and-forget；Renderer `VaultTransferRecoveryBridge` 再查 `recoveryStatus`：`recoverable` 则 `recover()`，`manual-required` 只通知。

## 6. Desktop Golden / 安装包

```text
G57  missing Vault → relocate → reopen
G58  physical Vault root rename
G59  同卷搬到另一父目录（跨卷 EXDEV 由单测覆盖 copy-verify-delete）
G60  copy document → new stable ID
G61/G62  copy group → internal links + managed assets
G63  move document → stable ID preserved
G64  move group → revisions preserved
G65  inbound boundary link blocks move
G66  outbound boundary link blocks move
G67  Move 碰撞不覆盖
G68/G69  stale source/destination plan blocks
G70  reference-style link rewrite
G71  interrupted relocation journal recovers
```

```text
P27 Vault relocation
P28 Cross-Vault Copy
P29 Cross-Vault Move + Revision
P30 Interrupted Transfer Recovery
```

## 7. Definition of Done

### Vault Relocation

- [x] Missing Vault 可重新定位
- [x] vaultId mismatch 拒绝
- [x] Physical Vault Rename
- [x] Physical Vault Move（同卷）
- [x] Cross-filesystem Move（EXDEV 单测）
- [x] Source 在 Destination verify 前不删除
- [x] VaultRegistry 正确更新
- [x] Watcher `restartWatching`
- [x] Link/Search 按 vaultId 不按绝对路径；搬迁后 invalidate / 跨库成功后 dest rebuild

### Cross-Vault Copy / Move / Markdown / Safety

- [x] Document/Group Copy；新 Stable ID；内部链接；受管附件；碰撞改名
- [x] Document/Group Move；Stable ID；Revision；源进回收站；边界 inbound/outbound blocker
- [x] 引用式提取与定义改写；inline 无回归；Wiki Link 不按 title 解析
- [x] stale plan / dirty / 碰撞不覆盖 / 搬迁 crash recovery / Renderer 无通用 fs

### Quality / Docs

- [x] 相关单测、typecheck
- [x] G57–G71 桌面套件本地全绿
- [ ] P27–P30 有产物时实测（无产物 skip）
- [x] lint / deps:check / build:web / build:desktop
- [ ] 远端 CI
- [x] 本文件、architecture、decisions、AGENTS、test-plan、requirements README

## 8. 明确不包含

cloud sync、多人协作、Wiki Link 按标题解析、Obsidian 全兼容、Windows/Linux QA、R013 Stage 7 真证书发布。

## 变更记录

| 版本 | 日期 | 说明 |
| ---- | ---- | ---- |
| 1.0 | 2026-09-10 | 从规划稿 Part B 拆出；按 Stage 0–6 落地状态书写 |
