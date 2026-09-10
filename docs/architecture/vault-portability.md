# Vault 可移植性与跨库操作（R014）

本文描述 Desktop **物理 Vault 根搬迁**与 **跨知识库 Copy/Move** 的当前实现。Portable Vault ZIP（`.e1.zip` 导入导出）仍见 [portable-vault.md](./portable-vault.md)，二者不是同一条通道。

**状态：Stage 0–6 已落地。** 需求全文见 `docs/requirements/R014-vault-portability-cross-vault-operations.md`。

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
- Journal：`userData/vault-relocations/<operationId>.json`（version 1）。源在目标校验完成前不删除。
- 成功后 `VaultRegistry.updateAbsolutePath` + `VaultWatcherService.restartWatching`。Search/Link SQLite 按 vaultId 分库，不跟绝对路径走。

## 跨库 Copy / Move

| | Copy | Move |
| --- | --- | --- |
| stable id | 新 UUID 写入 Frontmatter | 保持 |
| revision | 不复制 | 拷贝 `sn_<stableId>` series 目录 |
| 源 | 保留 | rename 进 `.e1/trash`，meta 记 `crossVaultMovedToVaultId` |
| 边界链接 | warning | inbound/outbound 均为 blocker |
| 路径碰撞 | 确定性改名 + warning | blocker |

附件：同 SHA-256 则复用目标已有文件；否则 `uniqueDestPath`，禁止覆盖。

预检指纹（源文件 SHA-256 + 目标将占用路径）在 execute 时重算，失配抛 `VAULT_TRANSFER_STALE_PLAN`。

跨库 Copy/Move 无独立 journal 文件：先 `wx` 写目标，Move 成功后再 trash 源。中断时源仍在。

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

Renderer 不得获得通用 fs 或任意绝对路径。错误码：`VAULT_ID_MISMATCH`、`VAULT_TRANSFER_STALE_PLAN`、`VAULT_TRANSFER_BLOCKED_DIRTY`、`VAULT_TRANSFER_PARTIAL_FAILURE`、`VAULT_TRANSFER_DUPLICATE_IDENTITY`。
