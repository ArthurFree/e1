# Desktop 自动更新路径（R009 Stage 6 + R013 Stage 5）

Desktop 安装包的检查 / 下载 / 安装链路。实现在
`electron/main/update/DesktopUpdateService.ts`，Renderer 只消费
`UpdateStatus`（`AppServices.update` 可选 port，Web 不装配）。

## 通道

```text
GitHub Releases（stable / latest-mac.yml + zip + blockmap）
        ↓
electron-updater（仅 isPackaged）
        ↓
DesktopUpdateService 状态机
        ↓
IPC update.* + events:updateStatus
        ↓
设置页「版本与更新」
```

`E1_UPDATE_FEED_URL` 可覆盖 feed，供隔离演练 signed vA → signed vB。

## 状态机

`idle → checking → available | not-available | error`

`available → downloading → downloaded → install()`（`quitAndInstall`）

- `autoDownload=false`：必须用户确认后才下载。
- `autoInstallOnAppQuit=true`：退出时安装已下载更新。
- error 只沉淀为 `state=error`，事件回调永不 throw（DIST-07）。
- 未打包（dev）为 `unsupported`，不触网。

## canAutoInstall（R013）

| 平台 | 值 | 行为 |
| --- | --- | --- |
| darwin + `codeSigned=true` | `true` | 检查 → 下载 → 重启安装 |
| darwin 未签名 / 探测失败 | `false` | download 为 no-op，UI 显示「前往下载」 |
| win32 | `true` | 保留为恢复 Windows 的未来能力（MAC-01 不验证） |
| 其它 | `false` | download 为 no-op，UI 显示「前往下载」 |

darwin 的 `codeSigned` 由 Main 对当前 `.app` 跑 `codesign` 探测（Developer ID + Hardened Runtime）。本地 unsigned `dist:mac` 为 false，正式 signed Release 为 true。

打开 darwin 自动安装的前提（TRUST 链已在 Release 门禁落实）：

```text
Developer ID valid
Notarization Accepted
Stapling valid
Gatekeeper accepted
signed packaged regression
```

## 升级后必须保持

```text
Vault root / Markdown / .e1/revisions
.e1/operations clean
recent vault state / preferences
safeStorage secrets（同一 appId / 签名身份）
LinkIndex / SearchIndex 可用或可重建
```

更新失败不得损坏已有安装。第一份真实 vA→vB 演练属于 R013 Stage 7 运营 QA。
