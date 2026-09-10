# macOS 分发信任（R013）

E1 Desktop 在 macOS arm64 上的签名、公证、Gatekeeper 与正式 Release 边界。
需求见 `docs/requirements/R013-macos-signing-trust.md`。

**当前实施状态：Stage 0–6 已落地。** Stage 7（第一份真实 GitHub Release + 浏览器下载 QA）是运营步骤，依赖仓库已配置的 Developer ID / Notary secrets 与维护者打 `vX.Y.Z` tag，不能在无证书环境下假完成。

## 冻结身份

```text
appId       = com.e1.notes
productName = E1
platform    = macOS
arch        = arm64
channel     = stable
provider    = GitHub Releases
证书类型     = Developer ID Application
```

`appId` 进入正式签名后视为长期稳定身份。R013 不修改 Vault / Markdown / `.e1/*` / 索引 schema。

## 本地构建 vs 正式 Release

| 路径 | 命令 | 签名 |
| --- | --- | --- |
| 本地 QA | `npm run package:desktop` / `npm run dist:mac` | unsigned 允许（`scripts/runElectronBuilder.mjs` 注入 `mac.identity=null`） |
| 正式 Release | tag `v*` → `E1_RELEASE_SIGNING=1` | 必须 Developer ID + Hardened Runtime + Notarization + Stapling |

核心不变量：本地可以没有 Apple 证书，正式 Release 不可以没有，也不得自动降级 unsigned。

## 凭证

GitHub Actions secrets（只进 macOS Release runner / 预检 job）：

```text
MAC_CERT_P12_BASE64
MAC_CERT_PASSWORD
APPLE_API_KEY          # .p8 正文，CI 落到 $RUNNER_TEMP/AuthKey.p8
APPLE_API_KEY_ID
APPLE_API_ISSUER
```

禁止进入 Git、artifact、committed `.env`、CI 日志正文。Renderer 与应用运行时不接触这些材料。

凭证只进入 import + `dist:mac` 两步；签完立即删除临时 Keychain / p12 / p8，并清空后续 step 的 `CSC_*`。packaged E2E 启动前再剥离一遍，Renderer/Main 运行时看不到证书。

`signing-preflight` 只打印：

```text
certificate configured = yes/no
notary credential configured = yes/no
```

## Hardened Runtime 与 Entitlements

正式 mac 配置：

```yaml
mac:
  hardenedRuntime: true
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.inherit.plist
```

最小白名单：`com.apple.security.cs.allow-jit`。
禁止：`get-task-allow`、`disable-library-validation`、`allow-dyld-environment-variables`。
扩权必须先登记失败现象、最小复现、安全影响与测试。

## 验证门禁

脚本（纯策略在 `scripts/macTrustPolicy.mjs`，真机命令在 verify*）：

```text
npm run signing:preflight
npm run verify:mac-signing        # identity / team / runtime / nested
npm run verify:mac-entitlements   # allowlist / denylist
npm run verify:mac-distribution   # stapler / spctl / DMG / ZIP
```

正式 Release 在 packaged E2E **之前**跑完上述校验。P01–P20 只跑 signed + notarized 产物；P21–P26 锁定信任与更新。

## 安全边界

- `.p12` / `.p8` / 证书密码不进仓库与 artifact。
- 临时 Keychain 只存活于 import + `dist:mac`；签完立即 `cleanupMacSigningIdentity.sh`，后续 verify / E2E / 上传步不再持有 `CSC_*`。
- 可选 secret `E1_EXPECTED_TEAM_IDENTIFIER`：导入证书的 Team ID 必须与之相符，verify 再用同一 Team ID 钉死 `codesign` 输出。
- darwin `canAutoInstall` 看运行时 `codeSigned` 探测，不看平台名。
- SHA256SUMS 针对最终 signed/notarized/stapled 的 dmg/zip。
- 更新失败不得损坏已有安装与用户数据（DIST-07，见 [desktop-update-path.md](./desktop-update-path.md)）。
