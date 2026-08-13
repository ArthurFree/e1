# R006-C5：Desktop 本地附件与资源闭环

## 1. 文档信息

| 项目 | 内容 |
|---|---|
| 需求编号 | R006-C5 |
| 需求名称 | Desktop 本地附件与资源闭环 |
| 所属阶段 | R006 Electron Desktop 本地 Vault 技术验证版 |
| 前置阶段 | R006-C4.1 Desktop 写入链路加固与身份一致性收口 |
| 当前状态 | 已完成（待验收） |
| 优先级 | P0 |
| 核心目标 | 让 Desktop 的图片与附件成为真实 Vault 文件，并与 Markdown 相对路径形成可迁移、可恢复、可被第三方工具理解的完整闭环 |
| 用户功能变化 | Desktop 支持插入图片、粘贴/拖拽图片、插入普通附件、资源渲染、附件下载、重启恢复 |
| 后续阶段 | R006-C6 Desktop 外部变化、Recovery 与平台服务收口 |

---

## 2. 背景

R006-C4 与 C4.1 已完成 Desktop Markdown 的真实写入与写入链路加固。

当前 Desktop 已具备：

```text
Electron Shell
      ↓
Desktop Runtime
      ↓
本地 Vault
      ↓
Markdown 扫描
      ↓
安全读取
      ↓
MarkdownCodec
      ↓
Tiptap
      ↓
SaveCoordinator
      ↓
DesktopMarkdownWriteService
      ↓
note.save
      ↓
AtomicFileWriter
      ↓
真实 Markdown 文件
```

当前已经完成：

- Markdown 真实读取；
- SHA256 ContentVersionToken；
- 自动保存；
- AtomicFileWriter；
- 外部修改冲突检测；
- Transient Vault 只读；
- Markdown Lossy Gate；
- Frontmatter 保留；
- Stable ID Adoption；
- `note.create`；
- Stable ID Session Alias；
- Scan Cache 路径一致性加固。

但 Desktop 资源能力仍未完成。

当前附件相关状态：

```text
DesktopAssetStore
├── getMetadata → undefined
├── getBinary → undefined
├── listByDocument → []
├── add → NOT_IMPLEMENTED
├── remove → NOT_IMPLEMENTED
└── removeOrphans → 0

asset.pick
→ NOT_IMPLEMENTED

asset.import
→ NOT_IMPLEMENTED

asset.resolveUrl
→ NOT_IMPLEMENTED
```

编辑器层已经完成 R005 Asset 抽象：

```text
Editor
  ↓
AssetServices
  ├── commands
  ├── access
  ├── picker
  └── notify
```

因此本阶段不重新设计编辑器资源系统，而是在 Desktop Runtime 中补齐真实 Adapter。

---

## 3. 产品目标

R006-C5 要完成以下完整用户闭环：

```text
用户打开 Desktop Vault
        ↓
插入图片 / 附件
        ↓
真实文件复制到 Vault/assets/
        ↓
编辑器立即显示资源
        ↓
Markdown 自动保存相对资源路径
        ↓
关闭 E1
        ↓
第三方 Markdown 软件仍能理解文件
        ↓
重新打开 E1
        ↓
Markdown 解析资源路径
        ↓
恢复 localImage / attachment 节点
        ↓
图片和附件继续正常工作
```

示例 Vault：

```text
MyNotes/
├── .e1/
│   └── vault.json
├── 学习/
│   └── React.md
└── assets/
    ├── fiber.png
    └── react.pdf
```

Markdown：

```markdown
# React

![Fiber](../assets/fiber.png)

[React 文档](../assets/react.pdf)
```

核心产品原则：

> Desktop 的资源必须是真实文件，而不是只能由 E1 理解的数据库记录。

即使用户删除 Electron cache、SQLite、IndexedDB 或 E1 应用，只保留 Markdown + assets/，也必须仍然得到一个可理解、可迁移的知识库。

---

## 4. 核心成功标准

C5 成功不是：

> Electron 能复制一个图片文件。

真正成功标准是：

```text
插入图片
↓
Vault/assets/foo.png
↓
Tiptap localImage
↓
Markdown 保存 ../assets/foo.png
↓
关闭 E1
↓
重新打开
↓
Markdown parse
↓
Asset Hydration
↓
localImage
↓
图片重新显示
```

对于普通附件：

```text
插入 PDF
↓
Vault/assets/design.pdf
↓
attachment node
↓
Markdown 保存 [design.pdf](../assets/design.pdf)
↓
重新打开
↓
attachment block 恢复
↓
附件仍可读取 / 另存
```

---

## 5. 非目标

R006-C5 明确不实现：

- SQLite FTS；
- 文件系统实时 Watcher；
- 自动识别外部附件修改；
- 资源版本历史；
- 图片编辑、压缩、裁剪；
- 自动媒体优化；
- 云附件 / CDN；
- 文件同步；
- 自动孤儿附件物理删除；
- Vault 外资源长期引用；
- 文件重命名后的全 Vault 链接重写；
- 页面移动后的批量资源重写；
- Reveal in Finder / Explorer；
- 原生附件预览；
- Desktop 完整回收站；
- Git 集成。

本阶段只解决：选择、导入、存储、渲染、序列化、重启恢复、资源缺失降级、Portable Vault 兼容。

---

## 6. 产品原则

### PR-01 资源必须属于 Vault

E1 Desktop 新导入的资源只能写入：

```text
<vaultRoot>/<assetsDirectory>/
```

不能写入 `userData/`、`temp/`、数据库或应用目录。

### PR-02 Markdown 永远写相对路径

允许：

```markdown
![图](../assets/a.png)
```

禁止把以下内容写入 Markdown：

```text
file:///Users/xxx/a.png
blob:...
attachment:...
e1-asset:...
asset:v1:...
```

其中 `e1-asset:` 与 `assetId` 只能作为运行时内部引用。

### PR-03 Renderer 不拥有源文件路径权限

原生文件选择后：

```text
Main
→ pickToken
```

Renderer 不拿源绝对路径。

### PR-04 资源先落盘，正文后引用

```text
资源文件写入成功
↓
插入 Editor Node
↓
SaveCoordinator
↓
Markdown 保存引用
```

允许产生暂时孤儿文件，但禁止产生已经保存、目标文件却不存在的新资源引用。

### PR-05 Desktop 不自动物理删除孤儿资源

删除编辑器节点只删除 Markdown 引用，不自动 `unlink assets/foo.png`。

### PR-06 Vault 外文件不能通过 Markdown 获得读取权限

Asset Hydration 只管理 `vault.assetsDirectory/*`，路径逃逸不得升级为受管 Asset。

---

## 7. 阶段拆分

```text
C5-A Asset Import Source / Port
C5-B AssetFileSystem + Token
C5-C Asset IPC + Custom Protocol
C5-D Desktop Asset Adapter
C5-E Markdown Asset Hydration
C5-F Markdown Asset Serialize
C5-G Editor 产品链路
C5-H Missing / Portable / E2E / Hardening
```

---

# 8. C5-A：Asset Import Source 演进

## 8.1 当前问题

现有 Application AssetPicker 返回：

```ts
interface PickedAsset {
  name: string;
  mimeType: string;
  size: number;
  data: Uint8Array;
}
```

Web 很适合 `File → arrayBuffer → Uint8Array`，但 Desktop 原生文件选择已有更安全的模型：

```text
Main 原生 Picker
→ pickToken
→ Renderer
```

如果继续强制 `Uint8Array`，Desktop 会形成 Main→Renderer→Main 的大字节往返。

## FR-01 AssetImportSource

```ts
export type AssetImportSource =
  | {
      kind: "bytes";
      data: Uint8Array;
    }
  | {
      kind: "authorized-ref";
      ref: string;
    };
```

## FR-02 PickedAsset 演进

```ts
export interface PickedAsset {
  name: string;
  mimeType: string;
  size: number;
  source: AssetImportSource;
}
```

Web Picker：`source.kind = "bytes"`。

Desktop Native Picker：`source.kind = "authorized-ref"`，`ref = pickToken`。

## FR-03 粘贴 / 拖拽兼容

Clipboard / Drag File 已在 Renderer，因此继续：

```text
paste / drop
↓
File.arrayBuffer
↓
source.kind = bytes
```

不得强制这些来源重新经过系统 Picker。

## FR-04 Application 不理解 pickToken

Application 只理解 `authorized-ref`，不得出现 `ElectronPickToken`、`DesktopFilePath` 等平台名称。

## FR-05 AssetCommandService 继续统一校验

继续统一负责：

```text
单附件 ≤ 20 MiB
单文档附件总量 ≤ 100 MiB
图片 MIME 白名单
文件名限制
```

Main 可以重复安全校验，但业务规则口径不得分叉。

---

# 9. C5-B：Main AssetFileSystem

新增：

```text
electron/main/filesystem/
└── AssetFileSystem.ts
```

职责：导入资源、读取资源、资源 stat、目标目录解析、安全文件名、同名冲突。

不得负责 Tiptap、localImage、attachment Node、Markdown AST。

## FR-06 assetsDirectory

必须来自 `.e1/vault.json`：

```json
{
  "assetsDirectory": "assets"
}
```

禁止业务逻辑硬编码 `join(vaultRoot, "assets")`。

## FR-07 Asset Destination Guard

最终目标必须位于真实 assets root 内，拒绝：

```text
../
absolute path
symlink escape
UNC
Windows drive escape
```

## FR-08 Asset 文件名清理

清理 `/ \ 控制字符 : * ? " < > |`、Windows 保留名、尾部点/空格，并遵守文件名字节上限。

## FR-09 同名冲突

```text
assets/image.png
assets/image (2).png
assets/image (3).png
```

## FR-10 Exclusive Create

不得 `exists() → copy()`，必须采用防覆盖语义。

---

# 10. Capability Token

建议抽象：

```text
CapabilityTokenStore<T>
```

复用目录选择 Token 的过期、单次消费与不可伪造语义。

## FR-11 Token 属性

- Main 生成；
- 随机不可预测；
- 单次使用；
- 5 分钟过期；
- Main 内存保存；
- 应用退出失效；
- Renderer 无法解析。

## FR-12 Token Payload

```ts
interface PendingFileSelection {
  absolutePath: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  createdAt: number;
}
```

---

# 11. C5-C：asset.pick

## FR-13 asset.pick 请求

```ts
interface AssetPickRequest {
  accept?: string[];
}
```

取消返回 `null`。

## FR-14 asset.pick 响应

```ts
interface PickedFile {
  pickToken: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
}
```

不得返回绝对路径。

## FR-15 MIME

Main 根据扩展名推断 MIME，无法识别时使用：

```text
application/octet-stream
```

---

# 12. C5-C：asset.import

支持两类来源：

```ts
type ImportAssetInput =
  | {
      vaultId: string;
      fileName: string;
      mimeType: string;
      source: {
        kind: "pick-token";
        token: string;
      };
    }
  | {
      vaultId: string;
      fileName: string;
      mimeType: string;
      source: {
        kind: "bytes";
        data: Uint8Array;
      };
    };
```

## FR-16 pick-token Import

```text
消费 token
↓
源文件 stat
↓
大小复核
↓
目标目录
↓
exclusive create
↓
copy
↓
返回 ImportedAsset
```

## FR-17 bytes Import

```text
Uint8Array
↓
大小复核
↓
目标目录
↓
exclusive create
↓
write
↓
返回 ImportedAsset
```

## FR-18 Import Result

```ts
interface ImportedAsset {
  assetId: string;
  relativePath: string;
  sizeBytes: number;
  mimeType: string;
}
```

---

# 13. Desktop Asset ID

Asset ID 必须：

- 不依赖 SQLite；
- 不包含裸绝对路径；
- 可在当前 Session 定位资源；
- 可由 Vault + relativePath 重建；
- 不写入 Markdown。

建议逻辑格式：

```text
asset:v1:<opaque>
```

即使内部可解析出 `vaultId + relativePath`，Main 仍必须重新执行 Vault resolve、PathGuard 和 assets root check。

---

# 14. C5-C：asset.read

新增：

```text
asset.read
```

## FR-20 AssetReadResult

```ts
interface AssetReadResult {
  assetId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  data: Uint8Array;
}
```

主要用于 Portable Export、明确下载/另存逻辑和测试。

普通图片显示不通过此 IPC 搬运二进制。

---

# 15. C5-C：安全资源协议

注册：

```text
e1-asset://
```

推荐：

```text
e1-asset://asset/<opaque-id>
```

## FR-21 Protocol Handler

```text
e1-asset URL
↓
解析 opaque assetId
↓
resolve vaultId + relativePath
↓
resolve assetsDirectory
↓
PathGuard
↓
文件读取
↓
Response
```

## FR-22 Protocol 不接受绝对路径

禁止：

```text
e1-asset:///Users/foo.png
e1-asset://asset?path=/Users/foo.png
```

## FR-23 Content-Type

根据 Asset Registry / extension 返回正确 MIME。

## FR-24 Missing

不存在时返回 404 或等价结果，Renderer 显示“图片不可用”，不得导致 Document 打开失败。

## FR-25 CSP

仅最小开放：

```text
img-src 'self' data: e1-asset:
```

不得 `img-src *`，不得给 `script-src` 开放该协议。

---

# 16. C5-D：DesktopAssetRegistry

新增：

```text
src/platform/desktop/DesktopAssetRegistry.ts
```

## FR-26 Registry Record

```ts
interface DesktopAssetRecord {
  id: string;
  vaultId: string;
  relativePath: string;
  name: string;
  mimeType: string;
  size: number;
  pageId: string;
}
```

## FR-27 Registry 生命周期

Registry 为 Session 派生索引，不写入 Markdown、vault.json、localStorage、SQLite。

## FR-28 Registry 能力

```ts
register(record): void
get(assetId): DesktopAssetRecord | null
findByPath(vaultId, relativePath): DesktopAssetRecord | null
listByDocument(pageId): DesktopAssetRecord[]
removeSessionReference(assetId): void
clearVault(vaultId): void
```

---

# 17. C5-D：DesktopAssetStore

替换当前 Stub。

## FR-29 getMetadata

```text
assetId
↓
Registry
↓
Attachment metadata
```

不存在返回 `undefined`。

## FR-30 getBinary

```text
assetId
↓
Registry
↓
api.asset.read
↓
BinaryAttachment
```

## FR-31 listByDocument

返回当前文档 Session 已登记资源。

## FR-32 add

```text
pageId
name
mime
size
data
↓
找到 pageId 所属 Vault
↓
api.asset.import(bytes)
↓
Registry.register
↓
Attachment
```

支持 Paste / Drag & Drop。

## FR-33 remove

第一版只移除 Session Registry 引用或 no-op，不物理删除文件。

## FR-34 removeOrphans

Desktop 继续：

```ts
async removeOrphans(): Promise<number> {
  return 0;
}
```

---

# 18. DesktopAssetPicker

```text
AssetPicker.pick
↓
api.asset.pick
↓
PickedAsset {
  source: authorized-ref
}
```

---

# 19. DesktopAssetAccessService

## FR-36 resolveUrl

```text
assetId
↓
e1-asset://...
```

不存在返回 `null`。

## FR-37 releaseUrl

Desktop custom protocol 不需要 revoke，安全 no-op。

## FR-38 download

推荐 Main `asset.saveAs`：

```text
assetId
↓
Save As
↓
copyFile
```

如果本阶段暂不扩展 IPC，可先通过 `asset.read` 实现，但不作为长期方案。

---

# 20. C5-E：Markdown Asset Hydration

当前 MarkdownCodec parse 只识别并收集相对资源引用，不会恢复 `localImage` / `attachment` 节点。

新增：

```text
DesktopMarkdownAssetHydrator
```

## FR-39 Hydration Input

```ts
interface HydrateAssetsInput {
  vaultId: string;
  pageId: string;
  noteRelativePath: string;
  document: unknown;
  assets: ParsedAssetReference[];
}
```

## FR-40 Managed Asset 判断

只有 resolvedPath 位于配置的 `assetsDirectory` 下，才视为 Managed Asset。

## FR-41 图片 Hydration

```markdown
![Fiber](../assets/fiber.png)
```

转换为：

```json
{
  "type": "localImage",
  "attrs": {
    "attachmentId": "asset:v1:...",
    "alt": "Fiber",
    "width": null
  }
}
```

## FR-42 附件 Hydration

只有整个段落仅包含一个本地非 Markdown 文件链接时，才升级为 attachment block。

## FR-43 Inline File Link

正文内嵌的普通文件链接保持 inline link，不升级为附件块。

## FR-44 外部图片

HTTP/HTTPS 图片继续作为普通 image，不下载、不纳管。

## FR-45 Vault 外相对资源

不得升级为 Desktop Asset。

## FR-46 Missing Managed Asset

合法受管路径但文件不存在时，文档仍可打开，UI 显示不可用。

## FR-47 Missing 引用不得自动删除

用户修改普通正文并保存时，缺失资源原 Markdown 引用仍需保留。

---

# 21. C5-F：Desktop Markdown Asset Serialization

C5 后 Desktop Writer 改用真实 Asset Resolver。

## FR-48 Asset Resolver

```text
attachmentId
↓
DesktopAssetRegistry
↓
vault relative asset path
↓
当前 note relativePath
↓
relativeVaultPath
```

## FR-49 Nested Note

例如：

```text
Note:
学习/前端/React.md

Asset:
assets/fiber.png
```

输出：

```markdown
![Fiber](../../assets/fiber.png)
```

## FR-50 统一 relativeVaultPath

新增共享纯函数：

```ts
relativeVaultPath(
  fromFile: string,
  targetPath: string,
): string
```

同时用于 Mention、Image、Attachment。

## FR-51 图片 Serialize

```markdown
![Fiber](../assets/fiber.png)
```

## FR-52 Attachment Serialize

```markdown
[design.pdf](../assets/design.pdf)
```

## FR-53 正常 Asset 不再触发 Lossy Gate

Registry 可解析时：

```text
serialize.lossy = false
```

## FR-54 Missing Asset Serialize

Registry 仍有原路径但文件缺失时继续输出原相对路径，可以给 warning，但不得删除引用。

---

# 22. C5-G：Editor 图片完整链路

## FR-55 `/图片`

```text
/图片
↓
DesktopAssetPicker
↓
原生文件选择
↓
pickToken
↓
AssetCommandService
↓
Desktop Import
↓
assets/
↓
localImage node
↓
SaveCoordinator
```

## FR-56 粘贴图片

```text
Clipboard File
↓
Uint8Array
↓
DesktopAssetStore.add
↓
asset.import(bytes)
↓
assets/
↓
localImage
```

## FR-57 拖拽图片

与 Paste 一致，继续使用现有落点逻辑。

## FR-58 图片格式

继续使用共享白名单：

```text
PNG
JPEG
GIF
WEBP
SVG
```

SVG 仅作为 `<img>` 资源，不使用 `innerHTML`，不可成为脚本来源。

---

# 23. 普通附件完整链路

## FR-59 Attachment Block

继续复用现有名称、MIME、大小、下载、移除 UI。

## FR-60 移除附件

只删除 Editor Node 和最终 Markdown 引用，不物理删除 assets 文件。

## FR-61 下载 / 另存

Desktop 产品语义后续建议改成“另存为”；本阶段可先保持共用“下载”文案。

---

# 24. C5-H：容量与失败

## FR-62 超限资源

单资源 >20 MiB：拒绝，不留半文件、不插入 Node。

## FR-63 单文档总量

继续共享 100 MiB 限制。

## FR-64 Disk Full

错误可使用：

```text
ASSET_WRITE_IO_ERROR
```

或更具体 `ASSET_NO_SPACE`。

## FR-65 Permission Error

```text
ASSET_WRITE_PERMISSION_DENIED
```

## FR-66 Source Disappeared

```text
ASSET_SOURCE_NOT_FOUND
```

## FR-67 Transient Vault

Main 必须返回：

```text
VAULT_READ_ONLY
```

且不得创建 assets/ 或任何新文件。

---

# 25. Portable Vault 兼容

## FR-68 Desktop Portable Export

Desktop AssetAccess.getBinary 必须通过 `asset.read` 返回真实字节。

## FR-69 Resource File Name

Portable Export 可继续使用自身的确定性资源命名，不要求等于 Desktop 物理文件名。

## FR-70 Web Portable Import

Desktop 导出的 `.e1.zip` 应至少保证图片、附件和正文可以被 Web Import 恢复。

---

# 26. persistentAssetPaths Capability

只有以下链路全部完成后才设置：

```ts
persistentAssetPaths = true
```

条件：

```text
import
read
resolveUrl
Hydration
Serialize
Restart
Missing fallback
Portable Export
```

---

# 27. 架构要求

```text
Editor
  ↓
AssetServices
  ↓
Application AssetCommandService
  ↓
Desktop Asset Adapter
  ↓
E1DesktopAPI
  ↓
Preload
  ↓
Main IPC
  ↓
AssetFileSystem
  ↓
Vault/assets
```

普通图片显示：

```text
LocalImage
↓
AssetAccess.resolveUrl
↓
e1-asset://...
↓
Main protocol
↓
Vault/assets
```

Portable Export：

```text
AssetAccess.getBinary
↓
asset.read
↓
Main
↓
Vault/assets
```

---

# 28. 架构门禁

继续保证：

```text
electron/**
不得 import src/editor

electron/**
不得 import React

components/**
不得访问 window.e1

editor/**
不得直接 import Desktop adapter
```

新增：

```text
Editor 不得知道 pickToken
Application 不得知道 absolutePath
Asset ID 不得写入 Markdown
Custom protocol 不得接受绝对路径
```

---

# 29. 测试要求

## 29.1 Capability Token

覆盖：

```text
正常 token
单次消费
重复消费
过期
伪造
用户取消
源文件被删除
```

## 29.2 AssetFileSystem

覆盖：

```text
普通文件
中文文件名
无扩展名
非法文件名
Windows 保留名
20MiB 边界
20MiB + 1
同名冲突
同名递增
symlink escape
自定义 assetsDirectory
权限错误
I/O 错误
```

## 29.3 Exclusive Import

已有：

```text
foo.png
foo (2).png
```

新导入必须得到：

```text
foo (3).png
```

且原文件字节不变。

## 29.4 Asset ID

同 Vault + 同 Path 身份一致；不同 Vault 相同 Path 身份不同。

## 29.5 Protocol Security

覆盖：

```text
合法 asset → 200
missing → 404
伪造 assetId → 拒绝
../ escape → 拒绝
symlink outside → 拒绝
非 assetsDirectory → 拒绝
```

## 29.6 Registry

覆盖 register / get / findByPath / listByDocument / clearVault / missing。

## 29.7 Hydration

覆盖：

```text
相对图片
嵌套 note 图片
attachment 独立段落
inline file link
外部 URL 图片
Vault 外路径
missing asset
中文资源路径
带空格路径
```

## 29.8 Hydration Round Trip

必须证明：

```text
Markdown
↓ parse
↓ hydrate
↓ serialize
↓ Markdown
```

资源路径保持语义等价。

---

# 30. Desktop E2E

## E2E-01 图片 Restart

```text
启动 Desktop
↓
插入 image.png
↓
等待 saved
↓
确认 assets/image.png
↓
确认 Markdown 相对路径
↓
关闭 Electron
↓
重新打开
↓
打开笔记
↓
图片正常显示
```

## E2E-02 Attachment Restart

```text
插入 PDF
↓
assets/design.pdf
↓
Markdown 相对链接
↓
关闭
↓
重开
↓
恢复 attachment block
```

## E2E-03 Duplicate Asset

同名不同内容连续导入：

```text
image.png
image (2).png
```

且内容分别正确。

## E2E-04 Transient Asset

仅预览 Vault 尝试导入，必须 `VAULT_READ_ONLY`，目录内容不变化。

## E2E-05 Missing Asset

外部删除资源后重开：

```text
文档成功
图片不可用
```

修改普通正文再保存，原资源 Markdown 引用仍存在。

## E2E-06 Delete Node

删除图片/附件节点后 Markdown 引用消失，但物理文件继续存在。

## E2E-07 Nested Note

```text
A/B/C.md
assets/a.png
```

输出正确相对路径。

## E2E-08 Portable Vault

Desktop 图片/附件导出 `.e1.zip`，资源进入 ZIP，并可被 Web Import 恢复。

---

# 31. Web 回归

所有 C5 PR 必须保证：

```bash
npm run ci
npm run test:e2e
npm run build:web
```

全部通过。

不得改变 Web IndexedDB AssetStore、Web Object URL、Web Picker、Portable Vault 既有语义。

---

# 32. Desktop 回归

至少：

```bash
npm run test:desktop
npm run build:desktop
npm run test:e2e:desktop
```

全部通过。

---

# 33. 性能要求

Native Picker 导入路径应：

```text
Main source
→ Main destination
```

不经过 Renderer 大字节往返。

普通图片显示通过 `e1-asset://`，不得每次执行：

```text
Main bytes
→ Renderer Uint8Array
→ Blob
→ ObjectURL
```

Portable Export 等明确需要字节的场景除外。

---

# 34. PR 拆分

## R006-C5-A：Asset Import Model

```text
AssetImportSource
PickedAsset 演进
Web Adapter 兼容
bytes / authorized-ref
AssetCommandService 适配
tests
```

## R006-C5-B：Asset File System

```text
CapabilityTokenStore 泛化
asset pick token
AssetFileSystem
assetsDirectory
安全文件名
exclusive import
错误映射
tests
```

## R006-C5-C：IPC & Protocol

```text
asset.pick
asset.import
asset.read
asset.resolveUrl
e1-asset protocol
CSP
security tests
```

## R006-C5-D：Desktop Asset Adapter

```text
DesktopAssetRegistry
DesktopAssetStore
DesktopAssetPicker
DesktopAssetAccessService
Desktop Runtime 装配
```

### Milestone 1

必须证明：

```text
原生选择
→ Vault/assets/file
→ assetId
→ e1-asset
→ Renderer 显示
```

## R006-C5-E：Markdown Asset Hydration

```text
DesktopMarkdownAssetHydrator
image → localImage
standalone file link → attachment
inline link preserve
missing preserve
managed assetsDirectory boundary
```

## R006-C5-F：Markdown Asset Serialization

```text
真实 Asset Resolver
relativeVaultPath
Nested Note
localImage serialize
attachment serialize
移除 Desktop Asset Lossy 占位
```

### Milestone 2

必须证明：

```text
插入
→ 保存
→ 关闭
→ 重启
→ Hydration
→ 正常显示
```

## R006-C5-G：Editor Product Flows

```text
/图片
Paste
Drop
/附件
下载/另存
移除节点
错误反馈
```

## R006-C5-H：Hardening & Portable

```text
Missing asset
同名文件
Transient
20MiB / 100MiB
Portable Export
Web Import compatibility
Desktop E2E
文档同步
```

---

# 35. Definition of Done

R006-C5 完成时必须满足：

```text
[x] DesktopAssetStore 不再是桩实现
[x] asset.pick 已真实实现
[x] 原生 Picker 不返回 absolutePath
[x] pickToken 单次消费、过期、不可伪造
[x] asset.import 已真实实现
[x] import 支持 pick-token
[x] import 支持 bytes
[x] Paste / Drop 不需要系统 Picker
[x] assetsDirectory 来自 vault.json
[x] 所有 Asset 目标路径经过 PathGuard
[x] symlink escape 被拒绝
[x] 同名资源不会覆盖
[x] 同名冲突确定性递增
[x] 单文件 20MiB 限制有效
[x] 单文档 100MiB 限制有效
[x] Transient Vault Main 层拒绝资源写入
[x] Desktop Asset ID 不写入 Markdown
[x] Asset ID 不包含裸绝对路径
[x] e1-asset:// 已实现
[x] e1-asset 不接受任意系统路径
[x] CSP 只最小开放 e1-asset 图片来源
[x] DesktopAssetAccess.resolveUrl 可显示图片
[x] releaseUrl 在 Desktop 为安全 no-op
[x] asset.read 支持 Portable Export
[x] Markdown 相对图片可以 Hydrate 为 localImage
[x] 整段本地附件链接可以 Hydrate 为 attachment
[x] Inline 本地文件链接保持普通 link
[x] 外部图片不进入 Asset 管理
[x] Vault 外路径不进入 Asset 管理
[x] Missing Asset 不阻止文档打开
[x] Missing Asset UI 显示不可用状态
[x] Missing Asset 引用不会因普通正文保存被删除
[x] Desktop Writer 使用真实 Asset Resolver
[x] Nested Note 输出正确 ../ 路径
[x] localImage 正常资源不再触发 Lossy Gate
[x] attachment 正常资源不再触发 Lossy Gate
[x] /图片 Desktop 可用
[x] 粘贴图片 Desktop 可用
[x] 拖拽图片 Desktop 可用
[x] 普通附件 Desktop 可用
[x] 删除图片/附件节点只删除 Markdown 引用
[x] Desktop 不自动物理删除 orphan asset
[x] Portable Export 可以读取 Desktop Asset
[x] Web Portable Import 可以恢复 Desktop 导出的资源
[x] persistentAssetPaths = true
[x] Web Asset 行为无回归
[ ] npm run ci 全绿
[ ] Web E2E 全绿
[x] Desktop 单元测试全绿
[ ] Desktop E2E 全绿
[x] Desktop E2E 覆盖图片插入→保存→重启
[x] Desktop E2E 覆盖附件插入→保存→重启
[x] Desktop E2E 覆盖 duplicate filename
[x] Desktop E2E 覆盖 Transient 拒写
[x] Desktop E2E 覆盖 Missing Asset
[x] Desktop E2E 覆盖 Nested Note relative path
```

---

# 36. C5 完成后的产品状态

完成 C5 后：

```text
Desktop
├── 本地 Vault ✅
├── Markdown 安全阅读 ✅
├── Markdown 自动保存 ✅
├── Atomic Write ✅
├── SHA256 冲突保护 ✅
├── Stable ID ✅
├── 新建 Markdown ✅
├── 图片真实文件 ✅
├── 图片 Paste / Drop ✅
├── 普通附件真实文件 ✅
├── Markdown 相对资源路径 ✅
├── 重启资源恢复 ✅
├── Missing Asset 降级 ✅
└── Portable Vault 资源兼容 ✅
```

仍未完成：

```text
文件实时监听
Vault 移动重新定位
Desktop Recovery 正式持久化
系统 SecretStore
Desktop 完整版本历史
SQLite FTS
文件移动 / 重命名
回收站
```

---

# 37. 下一阶段

C5 完成后进入：

# R006-C6：Desktop 外部变化、Recovery 与平台服务收口

建议主要解决：

```text
文件变化检测
Vault 外部移动 / 删除
主动/被动重新扫描
打开文档外部变更提示
Desktop RecoveryStore → userData
最近 Vault 重新定位
StorageHealth Desktop
SecretStore Desktop
平台能力开关收口
R006 PoC 最终验收
```

C6 不再扩大编辑器功能，而是把已经可以日常编辑的 Desktop Vault 变成：

> 对外部文件系统变化和应用异常更有韧性的本地优先桌面应用。
