# R009：Desktop 发布就绪与跨平台分发

> 版本：0.1  
> 状态：实现中（Stage 0–5 已完成，Stage 6 Auto Update 延期；产品身份冻结为 e1 / E1 / com.e1.notes / 0.1.0；无签名证书，Stage 4 以延期记录闭合）  
> 更新时间：2026-08-30  
> 前置需求：R006、R007、R008  
> 基线提交：`5fd2f7359878162f12e4ef7a1cb003d6f32a4948`

---

## 1. 背景

R006–R008 已基本完成 Desktop Local-first 核心能力建设：

- 本地 Vault 打开、扫描与恢复；
- Markdown 文档读写与版本冲突保护；
- Frontmatter 标题与标签写回；
- 附件持久化；
- 外部文件变化监听与冲突处理；
- 回收站、恢复、移动等基础文件操作；
- 设备级收藏与最近访问状态；
- Native Secret Store；
- Reveal in File Manager；
- SQLite / FTS5 全文搜索；
- 搜索索引自动重建与增量更新；
- Web / Desktop 双 Runtime 能力矩阵与 Operation Support；
- Desktop production runtime dependencies sanity check。

R008 完成后，产品已从「Desktop 技术验证版」进入「可日常使用的本地 Markdown 编辑器」阶段。

但当前仓库仍未达到真正的“发布就绪”状态：

1. 最新远端 `main` GitHub Actions 仍存在失败；
2. 当前 Desktop E2E 运行于源码仓库环境，并非真实安装包环境；
3. 尚未形成 `.dmg` / `.exe` 等发行产物；
4. 尚未建立签名、Notarization、Release Workflow；
5. 产品名称、App ID、userData 迁移规则尚未正式冻结；
6. 部分测试运行时仍存在异步 teardown / mock 漂移问题；
7. 发布前依赖安全审计尚未完成。

因此，下一阶段不建议继续扩展 Knowledge Graph、版本历史或复杂文件操作，而应优先把现有能力变成一个真正可安装、可发布、可验证的软件产品。

---

# 2. R008 完成结果评估

## 2.1 Desktop 搜索架构

R008 已完成 Desktop 全文搜索能力，推荐保持当前架构，不在 R009 再次重构：

```text
SearchPanel
    ↓
SearchQueryService
    ↓
FullTextSearchIndex Port
    ↓
DesktopSearchIndex
    ↓ IPC
Electron Main
    ↓
DesktopSearchDatabase
    ↓
SQLite / FTS5
```

数据源关系保持：

```text
Markdown Files = Source of Truth
SQLite         = Derived Index
```

索引可以随时删除、重建，不承担业务源数据职责。

外部变更链路：

```text
VaultWatcher
    ↓
ExternalVaultChangeService
    ↓
Normalized File Changes
    ↓
DesktopSearchIndexReconciler
    ↓
DesktopSearchIndex
```

该设计满足：

- Watcher 不直接控制 React；
- SQLite 不成为第二份 Source of Truth；
- 外部修改、删除后搜索结果可自动同步；
- 索引损坏后可以自动 rebuild。

R009 不应重新设计搜索存储模型。

---

## 2.2 搜索规模化结果

R008 已完成 1k / 10k / 50k Markdown 数据规模验证。

当前性能结果已经能够满足个人知识库的实际使用场景：

```text
1k documents
  rebuild ≈ 0.3s

10k documents
  rebuild ≈ 2.7s

50k documents
  rebuild ≈ 14.8s

query p95
  ≲ 51ms
```

因此：

- 1k：完全无压力；
- 10k：适合作为正常日常规模；
- 50k：首次 rebuild 时间仍可接受；
- 搜索查询延迟已经达到可交互水平。

R009 不设置进一步的 FTS 性能优化目标。

---

## 2.3 Runtime Operations 当前状态

Desktop 当前支持能力：

```text
Workspace
  rename       ❌
  favorite     ✅

Document
  create       ✅
  renameTitle  ✅
  renameFile   ❌
  move         ✅
  trash        ✅
  favorite     ✅

Group
  create       ✅
  rename       ❌
  move         ❌
  trash        ✅

Trash
  restore      ✅
  purge        ✅

Tag
  write        ✅

Revision
  read         ❌
  write        ❌
```

Operation Matrix 已经解决之前“UI 显示入口，但点击后才抛 NOT_IMPLEMENTED”的架构问题。

R009 不要求补齐所有 Operation。

未实现能力继续保持：

```text
operation = false
```

UI 必须隐藏或禁用。

---

# 3. 当前仍未闭环的问题

## 3.1 最新远端 Main 未全绿

R008 文档已标记完成，但最新远端 GitHub Actions 实际仍有失败。

当前主要失败：

```text
quality       ❌
e2e-desktop   ❌

build-web             ✅
build-desktop         ✅
desktop-runtime-deps  ✅
e2e-web               ✅
```

因此必须建立新的规则：

> Requirement 被标记为“已完成”之前，latest remote main 必须全部 GitHub Actions jobs green。

本地测试通过不能替代远端 CI。

---

## 3.2 AIAssistantPanel 测试存在异步 teardown 问题

当前测试：

```text
171 test files passed
1329 tests passed
```

但 Vitest 在结束阶段捕获：

```text
Unhandled Error

ReferenceError: window is not defined
```

调用链：

```text
react-dom
performWorkOnRootViaSchedulerTask
    ↓
scheduler
    ↓
Immediate.performWorkUntilDeadline
```

关联测试：

```text
src/components/editor/AIAssistantPanel.test.tsx
```

说明：

- 测试断言本身全部通过；
- 但 React Scheduler 在 jsdom 销毁 `window` 后仍有异步任务；
- 当前 teardown 不完整；
- 不能简单 suppress Vitest unhandled error。

### 目标修复

测试层：

```text
afterEach
  ↓
cleanup
  ↓
flush pending React work
  ↓
unstub globals
```

组件层建议增加异步请求生命周期保护：

```text
request generation
or
AbortController
```

避免组件卸载以后执行：

```text
setResult()
setStatus()
setError()
```

R009 必须解决产品代码异步生命周期，而不是仅修改测试让 CI 通过。

---

## 3.3 Reveal E2E 的测试边界错误

当前 G12 / G13 Reveal golden tests 在 Linux CI + xvfb 中调用真实：

```text
shell.showItemInFolder()
```

结果发生：

```text
30s timeout
worker teardown timeout
```

原因不是 IPC / PathGuard 失败，而是：

```text
GitHub Actions Ubuntu
+
xvfb
+
没有真实桌面文件管理器
```

因此真实 OS shell integration 不应该进入 Linux headless golden test。

### 正确测试分层

Main Unit Test：

```text
IPC Handler
    ↓
Vault Root
    ↓
PathGuard
    ↓
resolve real target
    ↓
Mock ShellLike.showItemInFolder
```

验证：

- 路径合法；
- 不泄露绝对路径到 Renderer；
- assetId 解码正确；
- 不存在文件正确返回错误；
- symlink escape 被拒绝。

Renderer / E2E：

```text
UI click
    ↓
preload
    ↓
IPC
    ↓
Main handler
    ↓
Injected Fake Shell
```

验证 UI 到 Main 全链路即可。

真实：

```text
shell.showItemInFolder
```

应转移到：

- macOS manual integration；
- Windows manual integration；
- 或 Packaged App Platform Smoke。

---

## 3.4 Desktop API Test Fixture 漂移

当前部分 Desktop component tests 会输出：

```text
Cannot read properties of undefined (reading 'get')
Cannot read properties of undefined (reading 'patch')
```

来源：

```text
DesktopVaultStateClient
```

测试因为 fallback 继续通过，但这说明：

```text
E1DesktopAPI mock
```

已经与真实 preload API 结构漂移。

R009 Stage 0 应建立统一：

```text
createMockDesktopApi()
```

所有 Desktop 测试共享。

后续增加：

- vaultState；
- search；
- secrets；
- reveal；
- file operations；

只更新一个 Mock Factory。

---

## 3.5 React Hook / Test Runtime Warning

当前存在若干 warning。

优先处理：

### TitleEditor

```text
useEffect missing dependencies
```

需要确认：

- 是否存在 stale closure；
- flush 是否稳定；
- title 是否会因为 effect dependency 缺失产生错误保存行为。

### DocumentEditor

```text
cleanup 时直接访问 coordinatorsRef.current
```

应该在 effect 创建阶段保存当前引用：

```text
const coordinators = coordinatorsRef.current
```

cleanup 使用该快照，避免 cleanup 时 ref 已切换。

### BlockHandle

当前测试仍出现：

```text
testing environment is not configured to support act(...)
```

应清掉。

其余：

```text
react-refresh/only-export-components
```

属于低优先级，可以在 R009 Stage 0 统一整理，但不作为主要阻塞。

---

# 4. R009 定义

# R009：Desktop 发布就绪与跨平台分发

英文：

```text
Desktop Release Readiness & Distribution
```

---

# 5. R009 核心目标

## G1 Remote Green Baseline

任何进入 Distribution 的 commit 必须满足：

```text
latest remote main
=
all CI jobs green
```

包括：

- quality；
- build-web；
- build-desktop；
- desktop-runtime-deps；
- e2e-web；
- e2e-desktop。

禁止通过：

- `allow_failure`；
- 忽略 Vitest unhandled errors；
- 暂时 skip 关键 golden tests；

实现假绿。

---

## G2 Product Identity Freeze

正式确定：

```text
name
productName
appId
version
protocol
userData directory
```

例如：

```json
{
  "name": "e1",
  "productName": "E1",
  "version": "0.1.0"
}
```

App ID 示例：

```text
com.e1.notes
```

具体值在 Stage 1 最终确认。

---

## G3 UserData Migration

产品 Identity 修改不能导致用户感觉“数据全部丢失”。

当前 Desktop 本地数据可能存在：

```text
userData/
├── recent-vaults.json
├── vault-state/
├── secrets.json
└── search-index/
```

如果 Electron app name 改变：

```text
notion-like-web
→
E1
```

默认 `userData` 目录也可能变化。

必须设计一次性：

```text
LegacyUserDataMigration
```

迁移策略：

```text
new userData 不存在
+
legacy userData 存在
        ↓
migration
```

必须迁移：

```text
recent-vaults.json
vault-state/
secrets.json
```

允许不迁：

```text
search-index/
```

因为搜索索引是 Derived Data，可以自动 rebuild。

---

## G4 Installable Desktop Artifacts

产生真正的：

```text
macOS:
  E1.dmg
  E1.zip

Windows:
  E1 Setup.exe
```

而不是只生成：

```text
dist/
dist-electron/
```

---

## G5 Packaged App Verification

增加真正安装包 / packaged binary 的 E2E。

测试：

```text
Packaged App
    ↓
launch
    ↓
isolated userData
    ↓
open Vault
    ↓
edit
    ↓
save
    ↓
restart
    ↓
search
    ↓
attachments
```

避免：

```text
repo node_modules
```

掩盖安装后缺失 runtime dependency 的问题。

---

## G6 Release Pipeline

建立：

```text
.github/workflows/release.yml
```

支持：

```text
git tag vX.Y.Z
    ↓
quality
    ↓
build
    ↓
package
    ↓
sign
    ↓
notarize
    ↓
checksums
    ↓
GitHub Release
```

---

# 6. 非目标

R009 不包含：

- Knowledge Graph；
- Backlinks；
- Link Graph；
- Desktop Revision History；
- Workspace Rename；
- Group Rename；
- Group Move；
- Physical Markdown File Rename；
- Plugin System；
- Cloud Sync；
- Multi-device Sync；
- Collaboration；
- Git Integration；
- Multi-window；
- Native Tray；
- 完整 Native Menu；
- Mobile Client；
- Notion Database；
- SQLite 作为 Source of Truth。

Auto Update 可以作为 R009 后半段或独立下一阶段，不阻塞第一版可下载安装。

---

# 7. 实施阶段

# Stage 0：Remote Green Baseline

**状态：本地全绿（2026-08-30），远端 CI 验证待 gh auth 恢复后确认**

实际实现与偏差记录：

- 0.1 AIAssistantPanel：查实真实产品 bug——`run()` 在 await 后无条件 setState，组件卸载后迟到回调触发 commit，命中 React dev 构建的 `window.event` 路径（jsdom 销毁后报 `window is not defined`）。修复为请求代次令牌守卫（卸载/关闭后置 null，await 后校验再 setState）；`src/test/setup.ts` 新增全局 afterEach 排空 Scheduler 宏任务消除测试侧竞态放大器。全量 1333 例连续 5 次无 unhandled error（修复前 5 次中 2 次复现）。遗留：`AIDraftModal.generate()` 同型问题待后续批次收口。
- 0.2 Reveal 分层：`E1_REVEAL_STUB=1` 时 Main 装配记录型 shell stub（`createRecordingShell`，写 userData/e2e-reveal-stub.log），E2E G12/G13 断言 stub 调用记录——UI→preload→IPC→PathGuard 全链路保真，仅最后一步 OS 调用替换，Linux headless 超时根因消除（3.7s/例）。真实 OS shell 集成转 macOS/Windows 手动验收。
- 0.3 统一 Mock：`src/test/createMockDesktopApi.ts`（返回类型标注 E1DesktopAPI，契约变更即编译失败防漂移）+ 键集合快照测试；16 个手写 mock 测试文件迁移，`Cannot read properties of undefined` 告警清零（顺带清掉已删 `vault.open` 的残留 mock 漂移实证）。
- 0.4 警告清理：TitleEditor（拆双 effect，覆盖同标题跨文档场景）与 DocumentEditor（cleanup 用 effect 期快照）均为纯警告无真 bug；BlockHandle act 警告系测试从 `react` 直引 `act`（应走 RTL 包装）所致，已修正。
- 0.5 本地验收：`npm run ci` 172 文件 / 1333 例全绿无 unhandled error；桌面 E2E 44 过 1 条件跳过（secrets 按 safeStorage 可用性）。
- 顺带修复：`src/test/projectTmp.ts` 并发互擦——整目录清空设计在 vitest 与 playwright 并发运行时互删对方夹具（ENOENT 假失败），改为每次运行独占 `run-<pid>-<ts>` 子目录 + 启动清扫 24h 前历史目录。

## 目标

R009 开始前先把 R008 完成状态真正收口。

## 必做

### 0.1 修复 AIAssistantPanel async lifecycle

增加：

```text
request cancellation / generation
```

确保：

```text
component unmount
    ↓
pending request completion
    ↓
NO state update
```

测试必须：

```text
afterEach cleanup
```

且 CI 不再出现：

```text
window is not defined
```

---

### 0.2 修复 Reveal CI 测试

Linux CI 不调用真实：

```text
shell.showItemInFolder
```

E2E 使用 injected shell stub。

真实 OS integration 转移到 platform-specific smoke / manual test。

---

### 0.3 建立统一 Desktop API Mock

建议：

```text
src/test/createMockDesktopApi.ts
```

提供完整 API：

```text
vault
note
asset
search
secrets
vaultState
reveal
watch
```

每个字段必须拥有明确默认行为。

---

### 0.4 清理关键 warnings

必须处理：

```text
TitleEditor hook dependency
DocumentEditor ref cleanup
BlockHandle act warning
```

低优先级 React Refresh warning 可单独整理。

---

### 0.5 CI Completion Gate

要求：

```text
quality              green
build-web            green
build-desktop        green
desktop-runtime-deps green
e2e-web              green
e2e-desktop          green
```

Stage 0 未完成，不进入 Packaging。

---

# Stage 1：Product Identity & UserData Migration

**状态：已完成（2026-08-30）**

实际实现与偏差记录：

- 身份落地：package.json `name` → `e1`（lockfile 同步）；`electron/main/main.ts` 顶层 `app.setName("E1")` 锁定 userData 目录；productName/appId 留给 Stage 2 的 electron-builder 配置。注意：Web 端 IndexedDB `DB_NAME` 与 BroadcastChannel 频道名保留 `notion-like-web` 字面量——那是存量 Web 数据键，改名会破坏用户数据，刻意不动。
- 迁移：`electron/main/migration/LegacyUserDataMigration.ts`（不 import electron，路径全注入可测）。legacy 目录按 Electron 默认规则 `appData/<旧 name>` 推导（旧包无 productName，即 `notion-like-web`）；whenReady 后、IPC 注册前执行，失败只告警不阻断启动。
- 语义：迁移 `recent-vaults.json` / `secrets.json` / `vault-state/`；不迁 `search-index/`（derived，缺失自动重建，R008 已落地）。幂等（marker `e1-userdata-migration.json` {version:1, migratedAt}）；逐条目「目标已存在跳过」；临时位置 + rename 可中断重试，部分失败不写 marker 下次自动续；legacy 全程只读；secret 内容不入日志；`E1_USER_DATA_DIR` 设置时跳过。
- 测试：迁移模块 7 例（成功/幂等/不覆盖/部分失败续跑/EACCES 恢复/env 跳过/marker）；electron 单测 373 例全绿；桌面 smoke + state E2E 4/4 回归通过。

## 1.1 Product Identity

冻结：

```text
package name
productName
appId
version
application display name
```

---

## 1.2 userData Migration

新增：

```text
electron/main/migration/
  LegacyUserDataMigration.ts
```

建议流程：

```text
app startup
    ↓
resolve new userData
    ↓
detect legacy userData
    ↓
migration needed?
    ↓
copy/move persistent state
    ↓
write migration marker
    ↓
continue startup
```

Migration 必须：

- 幂等；
- 可中断重试；
- 不覆盖已有新数据；
- 单文件失败不能损坏 legacy；
- secret 数据不能落日志；
- 支持 migration version。

Migration marker：

```json
{
  "version": 1,
  "migratedAt": "..."
}
```

---

## 1.3 Search Index

默认不迁：

```text
search-index
```

启动后：

```text
missing
    ↓
rebuild
```

减少迁移复杂度。

---

# Stage 2：Packaging

**状态：已完成（2026-08-30，macOS 本机实测）**

实际实现与偏差记录：

- 方案：electron-builder 26（不迁 Forge），配置落 `electron-builder.yml`（yml 而非 package.json build 字段——JSON 不支持注释，未签名/图标/asar 决策需随配置留痕）。
- 配置：appId `com.e1.notes`、productName `E1`、files 仅 `dist/**`+`dist-electron/**`（production node_modules 自动收集，chokidar 已验证进 asar）、`asar: true` 全量不 unpack、`npmRebuild: false`（无 native 依赖——SQLite 走 node:sqlite 内置）、mac dmg+zip（`identity: null` 未签名不公证，Stage 4 接证书后移除）、win nsis（oneClick:false，仅配置供 CI）。图标用默认，注释留痕后续替换。
- 脚本：`package:desktop`（build:desktop + `--dir` 快速校验）、`dist:mac`、`dist:win`；产物输出 `release/`（已 gitignore）。
- 本机实测（macOS arm64）：`E1-0.1.0-arm64.dmg`（121MB）+ zip 一次通过；asar list 确认 main.mjs/preload.cjs/desktop.html/chokidar 在包内；隔离 userData 真启动 10s 存活零报错（main/窗口/renderer/chokidar 解析全正常）。
- 偏差：`dist:win` 未本机实测（macOS 主机），CI 首跑可能需处理 nsis 下载缓存；package.json 缺 description/author 仅警告未补。

## 2.1 推荐方案

使用：

```text
electron-builder
```

不迁移 Electron Forge。

理由：

当前工程已经有：

```text
Vite
+
custom Electron Main build
+
esbuild
+
preload.cjs
```

无需为了 packaging 重构 build architecture。

---

## 2.2 Package Scripts

建议增加：

```json
{
  "scripts": {
    "package:desktop": "...",
    "dist:mac": "...",
    "dist:win": "..."
  }
}
```

---

## 2.3 Packaging Contents

必须验证：

```text
dist/**
dist-electron/**
production node_modules
```

特别检查：

```text
chokidar
preload.cjs
node:sqlite runtime
safeStorage
e1-asset:// protocol
```

---

## 2.4 ASAR

默认：

```text
asar: true
```

需要确认：

- SQLite 使用无需 unpack；
- chokidar 能正常加载；
- Electron Main ESM 路径计算正常；
- preload 路径正常；
- local protocol 正常。

如遇 native / path 问题，再最小范围：

```text
asarUnpack
```

禁止一开始全量 unpack。

---

# Stage 3：Packaged App E2E

**状态：已完成（2026-08-30，8/8 本机全绿）**

实际实现与偏差记录：

- `e2e/package/` 四 spec（launch/editing/search/platform）+ `packageFixture.ts` 共享夹具；`desktopArtifacts.ts` 新增 `requirePackagedArtifact()`（本地缺产物 skip、CI 抛错）与 `resolvePackagedExecutable()`（当前仅 darwin/arm64，Windows 留扩展点）。
- 启动方式为 `_electron.launch({ executablePath: release/mac-arm64/E1.app/... })`——全程不碰仓库 node_modules，真实覆盖 G5「repo node_modules 掩盖缺依赖」风险点。
- P01–P08 全覆盖：启动/preload（asar 内）、Vault 打开、编辑保存重启保持、附件（e1-asset:// 协议）、中文全文搜索（asar 内 node:sqlite FTS5 从零 rebuild）、watcher（asar 内 chokidar）、secrets（safeStorage 实测分流：安全后端验重启保持+磁盘无明文，不安全后端验降级文案不失败）、reveal（macOS 真实 showItemInFolder，Linux/Windows 手动验收口径注释留痕）。
- 分组：describe 前缀「安装包冒烟」+ `test:e2e:package` script；`test:e2e`/`test:e2e:update` 的 grep-invert 已扩为「桌面冒烟|安装包冒烟」，三套互斥经 --list 验证。
- 已接入 release.yml：macOS 打包后同 job 跑冒烟（产物在磁盘直接命中），失败阻断上传与 Release；失败日志 artifact 上传。
- 偏差：Windows 腿的 packaged E2E 待 nsis 产物路径约定落地后接入；套件不进 PR CI（macOS runner 成本），只在 release 流水线跑。

## 3.1 当前 E2E 问题

目前：

```text
electron.launch({
  args: ["."]
})
```

测试的是：

```text
源码仓库
+
dist
+
node_modules
```

不是用户实际安装的软件。

---

## 3.2 新增 Packaged Smoke

建议：

```text
e2e/package/
  desktop.package.launch.spec.ts
  desktop.package.vault.spec.ts
  desktop.package.search.spec.ts
```

---

## 3.3 Golden Flow

最少验证：

### P01 Launch

```text
安装包启动
```

### P02 Vault

```text
打开本地 Vault
```

### P03 Edit / Save

```text
编辑
→ 保存
→ 重启
→ 内容仍存在
```

### P04 Attachment

```text
插入附件
→ 保存
→ 重启
→ 附件存在
```

### P05 Search

```text
搜索标题 / 正文
```

### P06 Watcher

```text
外部修改 Markdown
→ UI 感知变化
```

### P07 Secrets

支持平台：

```text
safeStorage
→ API Key restart persistence
```

### P08 Reveal

平台真实 GUI smoke：

```text
showItemInFolder
```

不要求在 Linux headless CI 运行。

---

# Stage 4：Signing & Platform Security

**状态：延期（2026-08-30 决策：无签名证书，首版出未签名包）**

记录：

- 当前无任何代码签名证书（Apple Developer ID / Windows Authenticode 均无），Stage 4 不做签名实现，首版发布未签名安装包。
- 已知代价：macOS 未签名包触发 Gatekeeper「未知开发者」提示（用户需右键打开）；Windows 未签名触发 SmartScreen 拦截概率高。README 安装说明须如实写明。
- 签名通道已在 Stage 5 的 release.yml 预留为条件步骤（secrets 配齐即自动启用 codesign + notarize / Authenticode，无需再改 workflow）；启用签名后移除 `electron-builder.yml` 的 `identity: null`。
- DoD 对应项按「Windows signing 可复现或有明确延期记录」口径以本记录闭合；macOS signing/notarization 同为延期。
- 证书到位后的恢复动作：申请 Apple Developer Program → 证书/密钥入 GitHub Secrets（MAC_CERT_P12_BASE64 / CSC_KEY_PASSWORD / APPLE_API_KEY*）→ tag 发布即自动签名公证。

## macOS

需要：

```text
Developer ID Application
Hardened Runtime
Code Signing
Notarization
Stapling
```

目标：

```text
Gatekeeper
```

不提示“未知开发者 / 已损坏”。

---

## Windows

支持：

```text
Authenticode Code Signing
```

减少：

```text
SmartScreen
```

拦截概率。

---

## Secret Handling

证书 / Token 只允许存在：

```text
GitHub Actions Secrets
```

禁止进入：

```text
repository
.env.example
logs
artifacts
test fixtures
```

---

# Stage 5：Release Workflow

**状态：已完成（2026-08-30，未触发真实发布）**

实际实现与偏差记录：

- `.github/workflows/release.yml`：tag `v*` 触发 → version-check（tag 与 package.json version 必须一致）→ quality（同 ci 口径）→ build-verify（build:desktop + npm prune --omit=dev + verifyElectronRuntimeDeps）→ matrix package（macos-latest arm64 dmg/zip + windows-latest nsis x64，fail-fast: false 单腿失败可独立重试）→ release（SHA256SUMS.txt + action-gh-release 创建 Release）。
- electron-builder 一律 `--publish never`，Release 统一由 release job 创建；上传仅 dmg/zip/exe（blockmap/latest.yml 排除——Auto Update 延期，避免误导）。
- 条件签名（Stage 4 延期配套）：secrets 经 env 映射后判空——macOS 单步骤（移除 identity:null + AuthKey.p8 + CSC_LINK/CSC_KEY_PASSWORD + APPLE_API_KEY 注入，electron-builder 自动 codesign+notarize）；Windows 靠 WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD env 自动签名；未配置即未签名照常发布，不造假绿。
- Windows 首跑预案：`ELECTRON_BUILDER_CACHE` 收口 workspace + actions/cache（key 含平台+lockfile hash）。
- 首版矩阵仅 mac arm64 + win x64（universal 暂不产出，注释留痕）。
- 验证：prettier 通过；js-yaml 结构解析核对；未打 tag 未触发发布。mac 公证端到端效果待 secrets 配齐后首次 tag 验证。

新增：

```text
.github/workflows/release.yml
```

推荐触发：

```yaml
on:
  push:
    tags:
      - "v*"
```

流程：

```text
tag
 ↓
quality
 ↓
build web
 ↓
build desktop matrix
 ↓
package mac/windows
 ↓
sign
 ↓
notarize mac
 ↓
checksums
 ↓
GitHub Release
```

---

## Release Artifact

建议：

```text
E1-x.y.z-arm64.dmg
E1-x.y.z-x64.dmg
E1-Setup-x.y.z-x64.exe
SHA256SUMS.txt
```

是否首版支持 macOS universal binary，可根据实际开发机器与用户范围决定。

---

# Stage 6：Auto Update（可延期）

**状态：已延期（2026-08-30 决策）——不阻塞 v0.1.0，后续独立批次（可编号 R010）实施。**

Auto Update 不作为 R009 第一版 release 阻塞条件。

第一目标：

```text
v0.1.0
可以下载
可以安装
可以正常运行
```

之后再实现：

```text
v0.1.0
→
v0.1.1
```

推荐使用：

```text
electron-updater
```

更新必须支持：

- 检查更新；
- 下载；
- 用户确认安装；
- 更新失败不影响现有安装；
- 跨版本 userData migration；
- release channel。

如果工作量过大，可独立为：

```text
R010 Auto Update
```

并将 Knowledge Graph 顺延。

---

# 8. CI 规划

R009 后建议 CI 结构：

```text
quality
build-web
build-desktop
desktop-runtime-deps
e2e-web
e2e-desktop
package-smoke
```

Release workflow 与普通 CI 分离。

---

## Pull Request CI

验证：

```text
Source Correctness
```

---

## Release CI

验证：

```text
Distribution Correctness
```

禁止每个普通 PR 都做签名 / notarization。

---

# 9. Security Review

发布前必须进行一次依赖安全审计。

当前 npm install 报告：

```text
4 vulnerabilities
  1 moderate
  3 high
```

R009 不能简单执行：

```text
npm audit fix
```

而应该逐项分析：

```text
dependency
 ↓
dependency chain
 ↓
runtime / dev only?
 ↓
Electron Main / Renderer?
 ↓
attack surface
 ↓
upgrade impact
```

最终记录：

```text
Resolved
Accepted
Not Applicable
```

三类结论之一。

---

# 10. Packaged Runtime Checklist

必须验证安装包运行时：

```text
Electron Main
  ✅ ESM startup

Preload
  ✅ preload.cjs

Renderer
  ✅ desktop.html

Filesystem
  ✅ PathGuard

Watcher
  ✅ chokidar

SQLite
  ✅ DesktopSearchDatabase

Search Rebuild
  ✅ works after index delete

Secrets
  ✅ safeStorage

Asset Protocol
  ✅ e1-asset://

Vault State
  ✅ persistent

Recent Vault
  ✅ persistent

Crash / Restart
  ✅ no Markdown corruption
```

---

# 11. 数据安全不变量

继续保持现有原则：

## DIST-01

```text
Markdown files remain Source of Truth.
```

Packaging 不得改变数据模型。

## DIST-02

安装包升级不能导致 Vault 文件迁移。

Vault 必须保持普通目录。

## DIST-03

userData migration 不得删除 legacy 数据，直到确认新数据成功写入。

## DIST-04

Search Index 永远允许丢弃重建。

## DIST-05

Secret 不允许回退为明文存储。

## DIST-06

Renderer 仍然不得得到 absolutePath。

## DIST-07

任何安装、更新、迁移失败不得损坏 Markdown。

---

# 12. R009 Definition of Done

R009 完成需要全部满足：

## CI

- [ ] latest remote main 全绿；
- [ ] 无 Vitest unhandled errors；
- [ ] Desktop E2E 无 platform shell timeout；
- [ ] Packaged App Smoke 通过。

## Identity

- [ ] productName 冻结；
- [ ] appId 冻结；
- [ ] package name 冻结；
- [ ] userData 路径策略明确；
- [ ] legacy migration 测试通过。

## Packaging

- [ ] macOS DMG 可构建；
- [ ] Windows installer 可构建；
- [ ] production dependencies 完整；
- [ ] packaged app 可以启动；
- [ ] Vault 打开正常；
- [ ] Markdown 保存正常；
- [ ] 附件正常；
- [ ] 搜索正常；
- [ ] watcher 正常。

## Security

- [ ] safeStorage 正常；
- [ ] signing secret 不入库；
- [ ] npm vulnerability review 完成；
- [ ] Renderer 不泄露绝对路径。

## Release

- [ ] tag 可以触发 Release；
- [ ] Release 包含安装包；
- [ ] Release 包含 checksum；
- [ ] macOS signing / notarization 可复现；
- [ ] Windows signing 可复现或有明确延期记录。

## Documentation

- [ ] `docs/requirements/README.md` 更新；
- [ ] R009 文档阶段状态同步；
- [ ] `AGENTS.md` 更新；
- [ ] `README.md` 安装说明更新；
- [ ] Architecture / Decisions 同步发布架构。

---

# 13. R009 实现顺序

推荐严格按以下顺序：

```text
1. Remote Main 全绿
        ↓
2. Product Identity
        ↓
3. userData Migration
        ↓
4. electron-builder
        ↓
5. Packaged App Smoke
        ↓
6. macOS / Windows Signing
        ↓
7. Release Workflow
        ↓
8. v0.1.0 Release
        ↓
9. Auto Update
```

不要先做：

```text
Auto Update
Knowledge Graph
Native Menu
Group Rename
Revision History
```

这些都不应阻塞第一版真正可安装的 Desktop。

---

# 14. 下一阶段路线图

R009 完成后建议：

```text
R009
Desktop Release Readiness & Distribution
        ↓
R010
Knowledge Links & Backlinks
        ↓
R011
Desktop File Operations v2
        ↓
R012
Desktop Revision History
```

---

## R010：Knowledge Links & Backlinks

目标：

```text
Markdown Links
Wiki Links
Backlinks
Outgoing Links
Broken Links
Link Graph Index
```

数据仍保持：

```text
Markdown = Truth
Link Index = Derived Data
```

---

## R011：Desktop File Operations v2

补齐：

```text
Workspace Rename
Group Rename
Group Move
Physical Markdown Rename
```

需要重点解决：

- stable id；
- watcher；
- relative links；
- backlink index；
- external editor compatibility。

---

## R012：Desktop Revision History

补齐当前：

```text
revision.read = false
revision.write = false
```

目标：

```text
Local Revision Storage
Diff
Restore
Retention
Prune
```

Revision 数据必须继续避免成为 Markdown Source of Truth。

---

# 15. 当前项目成熟度判断

完成 R008 后：

```text
Architecture        9 / 10
Local Data Safety   9 / 10
Desktop Core        9 / 10
Search              9 / 10
Test Coverage       8 / 10
CI Stability        6 / 10
Distribution        2 / 10
```

当前最大的短板已经从：

```text
功能缺失
```

转变为：

```text
软件发行能力缺失
```

因此 R009 的核心不是继续堆产品功能，而是：

> 把已经完成的 Local-first Desktop 内核变成真正可以下载、安装、升级和长期使用的软件。

---

# 16. 变更记录

## 0.1 — 2026-08-30

初始草案。

根据 R008 完成结果与最新远端 CI 状态整理：

- 明确 R008 搜索架构无需继续重构；
- 发现 remote main 与本地验收结果存在偏差；
- 将 React/jsdom teardown 纳入 Stage 0；
- 将 Reveal xvfb timeout 归类为测试边界问题；
- 增加 Desktop API shared mock factory；
- 将 Product Identity / userData migration 提升为 R009 P0；
- 选择 electron-builder 作为现阶段 packaging 方案；
- 新增 Packaged App Smoke；
- 增加 signing / notarization / release workflow；
- Auto Update 默认允许延期；
- 后续路线调整为 R010 Knowledge Links、R011 File Operations v2、R012 Revision History。
