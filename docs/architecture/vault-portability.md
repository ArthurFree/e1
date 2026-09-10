# Vault 可移植性与跨库操作（R014）

本文描述 Desktop **物理 Vault 根搬迁**与 **跨知识库 Copy/Move** 的当前实现。Portable Vault ZIP（`.e1.zip` 导入导出）仍见 [portable-vault.md](./portable-vault.md)，二者不是同一条通道。

**状态：Stage 0–6 产品能力已落地；R014.1 完整性收口（journal v2、Destination Snapshot、no-clobber、identity/revision collision、跨库 Move journal、inspect≠recover）已落地。** R014 在 packaged P27–P30 真实产物与远端 Desktop Golden 全绿之前**不得**标成已完成。需求全文见 `docs/requirements/R014-vault-portability-cross-vault-operations.md` 与 `docs/requirements/R014.1-closeout-and-R015-knowledge-graph-plan.md`。

## 与既有操作的边界

```text
workspace.rename     → 只改 .e1/vault.json name（R011，PORT-01）
fileOperation.*      → 同一 Vault 内路径变更 + 源码级链接改写（R011）
vaultTransfer.*      → 根目录搬家 / 跨 Vault 复制移动（R014）
```

## 链路

```text
UI（存在性门控 services.vaultTransfer + operations.workspace.relocate
    / page.*.copyToVault|moveToVault）
  → VaultTransferService.plan（pageId → ScanCache relativePath；dirty 注入）
  → VaultTransferPreflightDialog
  → execute
  → IPC vaultTransfer.plan|execute
  → VaultRelocationEngine | VaultTransferEngine
  → Registry / Watcher / trash / revision series
  → Renderer：dest（及 Move 的 source）LinkIndex/SearchIndex rebuild
     + scans.invalidate
```

目录选择由 Main 执行。`plan` 消费一次性 `selectionToken`，绝对路径只留在 Main 的 pending 表；计划对象与 Renderer 均不含绝对路径。

## 整库搬迁

- Missing：最近记录路径不可访问 → 用户选目录 → 读 `.e1/vault.json` → `vaultId` 必须一致，否则 `VAULT_ID_MISMATCH`。
- Physical：目标父目录 + `newFolderName`。同卷 `rename`；`EXDEV` 走 copy-verify-delete。
- Journal：`userData/vault-relocations/<operationId>.json`（**version 2**）。v1 读出即 unsupported → `manual-required`，不迁移。
- 同卷 rename 必须先持久化 `rename-intent`，rename 成功后再写 `rename-applied`，禁止只靠内存判断 rename 是否已发生。
- 源在目标校验完成前不删除。
- 成功后 `VaultRegistry.updateAbsolutePath` + `VaultWatcherService.restartWatching`。Search/Link SQLite 按 vaultId 分库，不跟绝对路径走。
- `recoveryStatus` **只 inspect**，不改磁盘；`recover` 只处理可证明安全的 recoverable 项。ambiguous 进 `manual-required`。

### Relocation recovery 决策表（journal v2 + 真实 fs）

| Journal | Source | Destination | 处理 |
|---|---|---|---|
| prepared | 存在 | 不存在 | 尚未做 fs 动作，可删 journal |
| rename-intent | 存在 | 不存在 | rename 未发生，可安全放弃 |
| rename-intent | 不存在 | 存在且 vaultId/fingerprint 正确 | rename 已完成，推进 Registry |
| rename-intent | 存在 | 存在 | `manual-required`，不自动删任何一侧 |
| rename-intent | 不存在 | 不存在 | `manual-required` |
| rename-applied | 不存在 | 存在且验证正确 | 推进 Registry |
| copying / verifying | 存在 | — | 清 staging，保留源 |
| destination-ready（copy-verify-delete）且源仍在 | 存在 | 存在且验证正确 | 补 Registry，**不**自动删源 |
| v1 / 损坏 | — | — | `manual-required` |

## 跨库 Copy / Move

| | Copy | Move |
| --- | --- | --- |
| stable id | 新 UUID 写入 Frontmatter | 保持 |
| revision | 不复制 | 拷贝 `sn_<stableId>` series 目录 |
| 源 | 保留 | rename 进 `.e1/trash`，meta 记 `crossVaultMovedToVaultId` |
| 边界链接 | warning | inbound/outbound 均为 blocker |
| 路径碰撞 | 确定性改名 + warning | blocker |

附件：同 SHA-256 则复用目标已有文件；否则 exclusive create（`COPYFILE_EXCL`），禁止覆盖。目标已存在且 hash 不同 → stale/collision。

Move 额外门闩：目标已有相同 Stable Note ID → `VAULT_TRANSFER_IDENTITY_COLLISION`；目标已有 `sn_<id>` revision series → `VAULT_TRANSFER_REVISION_COLLISION`（exists → block，不 merge）。

Destination Snapshot 覆盖 notes / directories / assets / revision series / 与本次 Move 相交的 stable identity，指纹 `SHA256(canonical-json)`。execute 重算，任何差异 → `VAULT_TRANSFER_STALE_PLAN`。

跨库 journal：`userData/vault-transfers/<operationId>.json`。Copy 源不动；Move 必须 Destination 完整验证后才能 trash 源。`destination-ready` 的 Move 标 `manual-required`（不自动删源），用户显式 `recover` 才完成回收站。`source-trashed` 视为目标已提交。

## 引用式链接（Stage 5）

`scanMarkdownLinkDestinations` / `extractMarkdownLinks` / `rewriteMarkdownLinkDestinations` 覆盖：

```text
[text](href)
![alt](src)
[text][id] + [id]: dest
[text][]   + [text]: dest
```

只改写定义行的 destination 字节（source-preserving）。Wiki `[[…]]` 仍为 unsupported warning，不按标题解析。

## 安全

Renderer 不得获得通用 fs 或任意绝对路径。错误码：`VAULT_ID_MISMATCH`、`VAULT_TRANSFER_STALE_PLAN`、`VAULT_TRANSFER_BLOCKED_DIRTY`、`VAULT_TRANSFER_PARTIAL_FAILURE`、`VAULT_TRANSFER_DUPLICATE_IDENTITY`、`VAULT_TRANSFER_IDENTITY_COLLISION`、`VAULT_TRANSFER_REVISION_COLLISION`。
