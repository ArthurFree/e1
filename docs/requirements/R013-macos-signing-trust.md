# R013：macOS Signing & Trust

> 版本：0.1  
> 状态：实现中（Stage 0–6 已落地；Stage 7 待真实证书与 tag）  
> 更新时间：2026-09-10  
> 目标平台：macOS arm64  
> 前置需求：R009、R011.1、R012  
> 当前基线：`7f0e6da69f25edb4b7ff69b0793dfb5381847411`  
> 分发方式：GitHub Releases  
> 更新通道：stable

---

## 1. 目标

R013 不继续扩展编辑器业务能力，而是完成 E1 Desktop 在 macOS 上的正式信任、分发与自动升级闭环：

```text
Source
↓
CI
↓
Developer ID Application Signing
↓
Hardened Runtime
↓
Apple Notarization
↓
Stapling
↓
Gatekeeper Verification
↓
Signed DMG / ZIP
↓
GitHub Release
↓
Signed Auto Update
```

R012 完成后，E1 已拥有 Local Markdown Vault、Safe File Operations、Internal Links / Backlinks、Search、Revision History、Packaged E2E、Auto Update 状态机和 GitHub Release workflow。当前正式 macOS package 仍明确 `identity: null`，因此仍是 unsigned / unnotarized，macOS 自动安装更新也仍关闭。

R013 需要完成三件事：

1. **Trust**：让 Gatekeeper 能验证并信任 E1；
2. **Distribution**：正式 Release 必须是 signed + notarized；
3. **Upgrade**：macOS 更新链从“检查更新 + 手动前往 Release”升级为下载、安装和重启升级。

---

## 2. 当前基线

### 2.1 electron-builder

当前：

```yaml
appId: com.e1.notes
productName: E1

mac:
  target:
    - dmg
    - zip
  category: public.app-category.productivity
  identity: null
```

R013 后，正式 Release 配置中不得继续保留 `identity: null`。

### 2.2 Release Workflow

当前 release pipeline 已具备：

```text
tag vX.Y.Z
↓
version check
↓
quality
↓
build verify
↓
macOS arm64 package
↓
packaged E2E
↓
SHA256SUMS
↓
GitHub Release
```

同时已经预留：

```text
MAC_CERT_P12_BASE64
MAC_CERT_PASSWORD
APPLE_API_KEY
APPLE_API_KEY_ID
APPLE_API_ISSUER
```

但当前 secrets 缺失时会继续产出 unsigned release。R013 后必须改为 hard fail。

### 2.3 Auto Update

当前 macOS：

```text
check update          ✅
update available      ✅
open Release page     ✅
download update       ❌
quitAndInstall        ❌
auto install          ❌
```

只有完成 signed update chain 后，才允许 macOS `canAutoInstall = true`。

---

## 3. 核心不变量

### TRUST-01：正式 Release 必须签名

任何正式 `vX.Y.Z` tag 均不得产出 unsigned `.app` / `.dmg` / `.zip`。Signing credential 缺失或签名失败时：

```text
Release CI = failed
```

不得自动降级 unsigned 发布。

### TRUST-02：正式 Release 必须完成 Notarization

签名成功不是完成。正式 artifact 必须经过 Apple notarization，最终状态必须为：

```text
Accepted
```

否则 Release 失败。

### TRUST-03：必须 Staple Ticket

Notarization Accepted 后必须进行 stapling，并通过 `stapler validate`。

### TRUST-04：Gatekeeper 是最终信任门禁

不能只以 electron-builder exit code 判断成功。至少验证：

```bash
codesign --verify --deep --strict
spctl --assess
xcrun stapler validate
```

### TRUST-05：R013 不修改用户数据格式

R013 只改变 build / package / release / update，不修改：

```text
Markdown format
Vault data model
.e1/* schema
Revision format
LinkIndex schema
SearchIndex schema
```

### TRUST-06：不同时升级打包体系

R013 不夹带：Electron Forge migration、electron-builder major upgrade、Electron major upgrade、macOS universal/x64、Mac App Store、App Sandbox、Windows signing。

原则：

> 一次只改变一条发布信任链。

---

## 4. Product Identity Freeze

Stage 0 冻结：

```text
appId       = com.e1.notes
productName = E1
platform    = macOS
arch        = arm64
channel     = stable
provider    = GitHub Releases
```

其中 `appId` 进入正式签名与系统身份后，应视为长期稳定身份。

---

## 5. Developer ID Signing

外部分发使用：

```text
Developer ID Application
```

不使用 Development / adhoc / Mac App Store Distribution。

CI secrets：

```text
MAC_CERT_P12_BASE64
MAC_CERT_PASSWORD
```

约束：证书和密码不得进入 Git、日志、artifact、committed `.env`。

---

## 6. Notarization Credentials

推荐 App Store Connect API Key：

```text
APPLE_API_KEY
APPLE_API_KEY_ID
APPLE_API_ISSUER
```

`APPLE_API_KEY` 的 `.p8` 内容仅在 CI 中落到：

```text
$RUNNER_TEMP/AuthKey.p8
```

不得进入仓库或发布产物。

---

## 7. Hardened Runtime

正式 macOS build 必须启用：

```yaml
mac:
  hardenedRuntime: true
```

并在最终产物中进行真实验证，而不是只检查 builder 配置。

---

## 8. Entitlements

第一版以最小化为原则，优先从实际 Electron 运行所需能力开始，例如：

```text
com.apple.security.cs.allow-jit
```

默认禁止无理由加入：

```text
com.apple.security.get-task-allow
com.apple.security.cs.disable-library-validation
com.apple.security.cs.allow-dyld-environment-variables
```

如果某 entitlement 必须增加，应提供：

```text
失败现象
最小复现
为何必须
安全影响
对应测试
```

建议新增：

```text
build/entitlements.mac.plist
build/entitlements.mac.inherit.plist
```

主 App 与所有 Electron helper/nested code 均必须签名有效。

---

## 9. electron-builder 配置目标

建议从当前配置演进为：

```yaml
mac:
  target:
    - dmg
    - zip

  category: public.app-category.productivity
  hardenedRuntime: true
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.inherit.plist
```

正式 Release 不再使用 `identity: null`。

---

## 10. Local Build 与 Release Build 分离

本地开发不应被 Apple 证书阻断：

```text
npm run package:desktop
→ unsigned local QA allowed
```

正式 Release：

```text
forceCodeSigning = true
signing secrets required
```

核心不变量：

> 本地开发可以没有 Apple 证书，正式 Release 不可以没有。

---

## 11. Signing Preflight Gate

Release workflow 增加独立 `signing-preflight`，在 package 前检查所有必须 secrets。

推荐依赖：

```text
version-check
quality
build-verify
signing-preflight
        ↓
package
```

任何必需 secret 缺失都直接失败。

日志只允许输出：

```text
certificate configured = yes/no
notary credential configured = yes/no
```

禁止输出 secret 内容。

---

## 12. CI 临时 Keychain

推荐在 macOS runner 使用临时 Keychain：

```text
create temporary keychain
↓
import Developer ID certificate
↓
set key partition list
↓
codesign
↓
delete temporary keychain
```

如继续依赖 CSC_LINK 自动导入，也必须满足短生命周期、无日志泄漏、不污染系统默认 Keychain。

---

## 13. 正式 Release Pipeline

R013 后：

```text
tag
↓
version-check
↓
quality
↓
build-verify
↓
signing-preflight
↓
Developer ID import
↓
electron-builder
↓
codesign
↓
notarization
↓
stapling
↓
trust verification
↓
signed packaged E2E
↓
artifact upload
↓
GitHub Release
```

---

## 14. Signing Verification

至少执行：

```bash
codesign --verify --deep --strict --verbose=2 "E1.app"
```

并读取签名信息确认：

```text
Identifier = com.e1.notes
Authority  = Developer ID Application
TeamIdentifier 存在
Hardened Runtime 生效
```

所有 helper / framework / nested executable 也必须验证。

---

## 15. Entitlement Verification

建立 entitlement allowlist / denylist。

必须确认：

```text
required entitlement present
get-task-allow absent
unexpected debug entitlement absent
```

避免未来配置漂移。

---

## 16. Notarization

正式 Release 必须执行：

```text
submit
↓
wait
↓
Accepted
```

以下情况全部阻断 Release：

```text
Rejected
Invalid
credential error
submission failure
timeout
```

失败时可以保留 submission id / Apple notarization log，但不得保留私钥材料。

---

## 17. Stapling

Notarization Accepted 后执行：

```bash
xcrun stapler staple E1.app
xcrun stapler validate E1.app
```

DMG 如适用也应进行对应 stapling / validation。

---

## 18. Gatekeeper Verification

对最终 app 执行：

```bash
spctl --assess --type execute --verbose=4 E1.app
```

目标：

```text
accepted
source = Notarized Developer ID
```

最终 DoD 以 Gatekeeper 接受为准，而不是只以 builder 成功为准。

---

## 19. DMG Verification

最终用户下载的是 DMG，因此还要验证实际 DMG 内的 E1.app：

```text
mount DMG
↓
locate E1.app
↓
codesign verify
↓
spctl assess
↓
stapler validate
↓
unmount
```

不能只测 `release/mac-arm64/E1.app` 中间目录。

---

## 20. ZIP Verification

macOS auto-update 使用 ZIP，因此还必须验证 ZIP 解压后的 E1.app 仍满足：

```text
codesign valid
Gatekeeper accepted
notarization/stapling valid
```

---

## 21. Signed Packaged E2E

正式 Release pipeline 中，现有 P01–P20 必须改为在 signed + notarized artifact 上运行：

```text
codesign
↓
notarize
↓
staple
↓
verify
↓
P01–P20
```

不能先跑 E2E 再签名。

新增：

```text
P21 Developer ID signing identity valid
P22 Hardened Runtime + entitlement whitelist valid
P23 notarization + stapling + Gatekeeper accepted
P24 signed app safeStorage persistence
P25 signed vA → signed vB auto-update
P26 update 后 Vault / revisions / secrets 状态保持
```

---

## 22. safeStorage 专项验证

签名身份稳定后必须验证：

```text
install signed vA
↓
write secret
↓
quit/relaunch
↓
secret readable
↓
upgrade signed vB
↓
secret still readable
```

不能出现升级后 Keychain 将新版识别为另一个应用的情况。

---

## 23. Auto Update 开启条件

只有以下全部完成，才能打开 macOS 自动安装：

```text
Developer ID valid
Notarization Accepted
Stapling valid
Gatekeeper accepted
signed packaged regression green
signed update rehearsal green
```

此后 `DesktopUpdateService` 才允许 macOS：

```text
canAutoInstall = true
```

---

## 24. Signed Update Rehearsal

利用现有 `E1_UPDATE_FEED_URL`，先在隔离环境完成：

```text
signed E1 vA
signed E1 vB
latest-mac.yml
blockmap
zip
```

测试：

```text
install vA
↓
check update
↓
available vB
↓
download
↓
downloaded
↓
quitAndInstall
↓
restart
↓
version == vB
```

---

## 25. Update Data Integrity

升级后必须验证：

```text
Vault root unchanged
Markdown unchanged
.e1/revisions unchanged
.e1/operations clean
recent vault state preserved
safeStorage secrets preserved
preferences preserved
Link/Search 可正常使用或重建
```

更新失败不得损坏已有安装与用户数据。

---

## 26. First Real GitHub Release

当前仓库仍无真实 GitHub Release。R013 必须完成第一份真实：

```text
vX.Y.Z
```

Release。

版本必须：

```text
tag version == package.json version
```

第一份 Release 可以继续处于 `0.1.x`，但必须是完整 signed + notarized artifact。

---

## 27. Release Artifacts

正式 Release 至少包含：

```text
E1-*.dmg
E1-*.zip
latest-mac.yml
*.blockmap
SHA256SUMS.txt
```

不得上传：

```text
.p12
.p8
certificate password
temporary keychain
notary credentials
```

SHA256 必须针对最终 signed/notarized/stapled artifact 计算。

---

## 28. Real Download QA

至少在真实 macOS 机器执行：

```text
从 GitHub Release 下载 DMG
↓
浏览器写入 quarantine
↓
打开 DMG
↓
拖入 Applications
↓
首次启动
↓
Gatekeeper 不阻断
↓
打开 Vault
↓
编辑 / 重启
↓
自动更新
```

不能只从本地 `release/` 目录启动，因为那无法模拟浏览器下载后的 quarantine / Gatekeeper 场景。

---

# 29. Stage 0 — Identity & Contract Freeze

完成：

```text
appId/productName/arch/provider 冻结
Developer ID 类型冻结
credential names 冻结
Hardened Runtime 策略
Entitlement 最小白名单
正式 Release 禁止 unsigned fallback
```

输出：

```text
R013 requirement
macOS trust architecture doc
security decision
```

---

# 30. Stage 1 — Signed Hardened Runtime Build

实现：

```text
Developer ID import
remove release identity:null
hardenedRuntime
entitlements
release forceCodeSigning
```

验收：

```text
codesign valid
identity valid
runtime valid
nested code valid
```

---

# 31. Stage 2 — Notarization + Stapling

实现：

```text
App Store Connect API Key
notary submission
Accepted gate
staple
stapler validate
```

任一步失败都阻断 Release。

---

# 32. Stage 3 — Trust Verification Gate

加入：

```text
codesign verification
entitlement whitelist
spctl Gatekeeper
stapler validation
DMG validation
ZIP validation
```

形成独立 Distribution Correctness gate。

---

# 33. Stage 4 — Signed Packaged Regression

把 P01–P20 移到 signed/notarized artifact 后运行，并新增 P21–P24。

重点回归：

```text
Vault read/write
SQLite
Watcher
safeStorage
Reveal
Revision
Journal
e1-asset://
```

---

# 34. Stage 5 — macOS Auto Update

打开 macOS `canAutoInstall`，完成 signed vA → signed vB：

```text
check
download
progress
downloaded
quitAndInstall
restart
```

新增 P25–P26。

---

# 35. Stage 6 — Release Pipeline Hardening

正式 Release workflow 必须满足：

```text
missing secret      → fail
signing error       → fail
notary rejected     → fail
staple invalid      → fail
Gatekeeper rejected → fail
packaged E2E failed → fail
```

不得存在 unsigned fallback。

---

# 36. Stage 7 — First Real Release

执行：

```text
version bump
↓
tag vX.Y.Z
↓
Release workflow
↓
signed/notarized artifacts
↓
GitHub Release
↓
real download QA
↓
auto-update QA
```

只有完成后 R013 才能标记“已完成”。

---

## 37. Test Matrix

### Signing

```text
valid Developer ID
wrong certificate password
missing certificate
expired certificate
wrong certificate type
```

### Notarization Credential

```text
valid API key
missing API key
invalid API key / issuer / key id
```

### Hardened Runtime / Entitlements

```text
main app
Electron Framework
Helper
Helper Renderer
Helper GPU
Utility/Plugin（如存在）
required entitlement present
forbidden entitlement absent
```

### Notarization / Stapling

```text
Accepted
Rejected
network failure
timeout
app staple
app validate
DMG validation
```

### Gatekeeper

```text
builder app
DMG app
browser-downloaded DMG
ZIP updater app
```

### Auto Update

```text
no update
update available
download progress
downloaded
quitAndInstall
restart
network failure
invalid update artifact
```

---

## 38. 建议新增脚本

```text
scripts/verifyMacSigning.mjs
scripts/verifyMacEntitlements.mjs
scripts/verifyMacDistribution.mjs
```

职责：

```text
verifyMacSigning
→ identity / team / runtime / nested code

verifyMacEntitlements
→ allowlist / denylist

verifyMacDistribution
→ stapler / spctl / DMG / ZIP
```

---

## 39. 建议文档更新

新增：

```text
docs/requirements/R013-macos-signing-trust.md
docs/architecture/macos-distribution-trust.md
```

更新：

```text
docs/requirements/README.md
docs/architecture/desktop-update-path.md
docs/decisions.md
AGENTS.md
README.md
```

---

## 40. Security Checklist

- [ ] `.p12` 不进 Git；
- [ ] `.p8` 不进 Git；
- [ ] secrets 不进 artifact；
- [ ] secrets 不进 CI log；
- [ ] certificate password 不写入仓库文件；
- [ ] temporary keychain 仅存活于 release job；
- [ ] notary credential 只在 macOS release runner 使用；
- [ ] Renderer 不接触签名 credential；
- [ ] 应用运行时不包含 Apple API private key。

---

## 41. 非目标

R013 不做：

```text
Mac App Store
App Sandbox
MAS entitlement
Windows signing
Linux packaging
macOS x64
macOS universal
Sparkle
custom update server
delta update redesign
release dashboard
crash reporting
telemetry
auto rollback service
Electron major upgrade
electron-builder major upgrade
```

---

## 42. R013 Definition of Done

### Signing

- [x] Developer ID Application 类型与 secret 名已冻结（真实证书由仓库 Secrets 配置）；
- [x] 正式 Release 不再 `identity: null`；
- [x] Hardened Runtime 开启；
- [x] entitlement 最小化且有白名单测试；
- [ ] 主 app 与全部 nested code 签名有效（待 Stage 7 真证书产物）；
- [x] 正式 Release 强制 code signing；
- [x] signing secret 缺失时 Release fail。

### Notarization

- [x] App Store Connect API Key 接入路径已落地（`$RUNNER_TEMP/AuthKey.p8`）；
- [ ] notary submission 成功（待 Stage 7）；
- [ ] final status = Accepted（待 Stage 7）；
- [x] notarization failure 阻断 Release；
- [x] notarization diagnostics 无 secret 泄漏（预检只输出 yes/no）。

### Stapling / Gatekeeper

- [ ] App stapling 成功；
- [ ] `stapler validate` 成功；
- [ ] `spctl --assess` accepted；
- [ ] source = Notarized Developer ID；
- [ ] 浏览器下载的真实 DMG 首次启动通过。

### Artifacts

- [ ] DMG signed/notarized；
- [ ] ZIP signed/notarized；
- [ ] latest-mac.yml 正确；
- [ ] blockmap 正确；
- [ ] SHA256SUMS 针对最终 artifact 生成。

### Packaged QA

- [ ] P01–P20 在 signed/notarized app 全绿；
- [ ] P21 signing identity；
- [ ] P22 runtime + entitlements；
- [ ] P23 notarization/stapling/Gatekeeper；
- [ ] P24 safeStorage signed persistence；
- [ ] P25 signed vA → vB auto update；
- [ ] P26 update 后 Vault / revisions / secret 状态保持。

### Auto Update

- [x] macOS `canAutoInstall = true`；
- [x] check / download / progress / downloaded（状态机 + 设置页；真机 vA→vB 待 Stage 7）；
- [x] quitAndInstall（状态机已接通；真机待 Stage 7）；
- [ ] restart into new version（待 Stage 7）；
- [x] update failure 不损坏现有安装（DIST-07）；
- [ ] safeStorage 跨版本保持（待 Stage 7 真升级）。

### Release

- [ ] package.json version 与 tag 一致；
- [ ] 第一份真实 GitHub Release 创建；
- [ ] Release 包含 dmg / zip / latest-mac.yml / blockmap / SHA256SUMS；
- [ ] GitHub Release 下载后真实 Gatekeeper QA 通过；
- [ ] Release workflow 全绿。

### Architecture / Docs

- [x] requirements README 更新 R013；
- [x] macOS distribution trust 架构文档；
- [x] desktop update path 更新；
- [x] decisions 更新；
- [x] AGENTS 更新；
- [x] README 更新；
- [x] signing / notarization / update 安全边界记录完成。

---

## 43. 推荐实施优先级

```text
1. Signing identity correctness
2. Hardened Runtime / entitlement correctness
3. Notarization
4. Gatekeeper trust
5. Signed packaged regression
6. Auto update
7. First real release
```

不要反过来：

```text
先发布
↓
再补 notarization
```

---

## 44. 最终路线

```text
R012 Desktop Revision History
        ↓
R013 Stage 0 Identity / Credential Contract
        ↓
R013 Stage 1 Developer ID + Hardened Runtime
        ↓
R013 Stage 2 Notarization + Stapling
        ↓
R013 Stage 3 Gatekeeper Verification
        ↓
R013 Stage 4 Signed Packaged Regression
        ↓
R013 Stage 5 Signed Auto Update
        ↓
R013 Stage 6 Release Hardening
        ↓
R013 Stage 7 First Real GitHub Release
```

R013 完成后，E1 Desktop 才从“可打包的 Electron 应用”升级为“可可信分发、可安全升级的 macOS 产品”。

---

## 45. 实施记录（2026-09-10）

Stage 0–6 代码与门禁已落地，偏差如下：

- **本地 / Release 分流**：`electron-builder.yml` 不再写 `identity: null`。本地 `npm run package:desktop` / `dist:mac` 经 `scripts/runElectronBuilder.mjs` 注入 unsigned 并剥离 `CSC_*`；正式 Release 设 `E1_RELEASE_SIGNING=1` 并 `forceCodeSigning` + `notarize`。
- **凭证生命周期**：`MAC_CERT_*` / `APPLE_API_*` 只进 import step；`dist:mac` 之后立刻删临时 Keychain / p12 / p8 并清空 `GITHUB_ENV` 中的 `CSC_*`。packaged E2E `launchPackaged` 再剥离一遍。
- **canAutoInstall**：darwin 仅当运行时探测到 Developer ID + Hardened Runtime（`codeSigned=true`）才为 true；本地 unsigned 包降级「前往下载」。
- **P25/P26**：无 `E1_UPDATE_FEED_URL` 时 P25 只断言 signed app `canAutoInstall=true`；P26 断言同一 signed binary 重启后 Vault / secret 保持。完整 signed vA→vB `quitAndInstall` 与浏览器 quarantine QA 属于 Stage 7，需真实证书与两份签名产物。
- **Stage 7 未完成**：本批次不打 tag、不创建 GitHub Release。维护者在仓库配置 signing secrets（含可选 `E1_EXPECTED_TEAM_IDENTIFIER`）后，bump `package.json` version 并推送 `vX.Y.Z` 即可走强制签名流水线。
