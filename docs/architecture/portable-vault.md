# Portable Vault v1 格式定义（R005）

Portable Vault 是 Web 与 Desktop 之间的数据迁移与备份通道：Web 端导出、Web 端重新导入、未来 Desktop 直接打开（DUAL-09）。本文取自 r005.md §十二并补全为定稿格式。

**状态：v1 为设计定稿，实现在阶段 7。** 阶段 7 实现时如必须调整字段，先更新本文与 ADR，再改代码。

## ZIP 布局

导出文件为单个 ZIP，命名 `<Vault名>.e1.zip`：

```text
MyNotes.e1.zip
├── manifest.json
├── vault.json
├── notes/
│   ├── 工作/
│   │   └── 项目 A.md
│   └── 学习/
│       └── React.md
├── assets/
│   ├── image.png
│   └── design.pdf
└── metadata/
    ├── tree.json
    └── page-map.json
```

- `notes/`：文档页面序列化后的 Markdown 文件，目录层级对应 group 页面层级；每个 Markdown 文件携带 Frontmatter（id/title/tags/created/updated）。
- `assets/`：图片与附件的真实二进制文件，文件名与 Markdown 中的相对引用一致。
- `metadata/tree.json`：页面排序（position）与树结构增强信息；缺失时导入方按目录扫描顺序重建。
- `metadata/page-map.json`：Page ID → `notes/` 相对路径映射，用于链接重写与稳定 ID 对照。

## manifest.json（导出信封）

```json
{
  "format": "e1-vault",
  "formatVersion": 1,
  "generator": "e1-web",
  "exportedAt": "2026-07-28T12:00:00+08:00",
  "noteCount": 42,
  "assetCount": 7
}
```

- `format` / `formatVersion`：导入方校验的第一道关口，不匹配的版本直接拒绝并报「数据格式版本不支持」。
- `generator`：导出方标识（`e1-web` / 未来 `e1-desktop`），仅诊断用途，不影响导入语义。
- `noteCount` / `assetCount`：供导入报告与完整性自检对照。

## vault.json（知识库元数据）

```json
{
  "format": "e1-vault",
  "formatVersion": 1,
  "vaultId": "01J...",
  "name": "我的知识库",
  "createdAt": "2026-07-28T10:00:00+08:00",
  "assetsDirectory": "assets",
  "identityMode": "frontmatter"
}
```

- `vaultId`：知识库稳定 ID；导入 Web 时映射为新 Workspace。
- `assetsDirectory`：资源目录名（v1 固定 `assets`），供 Markdown 相对路径解析。
- `identityMode: "frontmatter"`：笔记稳定 ID 的载体为各 Markdown 文件的 Frontmatter `id`（v1 唯一取值）。

## Web 数据 → Portable Vault 转换规则

| Web 数据      | Portable Vault                 |
| ------------- | ------------------------------ |
| Workspace     | Vault 根目录                   |
| Group Page    | 文件夹                         |
| Document Page | Markdown 文件                  |
| Page ID       | Frontmatter `id`               |
| Tag           | Frontmatter `tags`             |
| LocalImage    | `assets/` 文件 + Markdown 图片 |
| Attachment    | `assets/` 文件 + Markdown 链接 |
| Position      | `metadata/tree.json`           |
| Favorite      | 可选写入 metadata              |
| Trash         | 默认不导出，可选择包含         |
| Revision      | 默认不导出，可选择包含         |

正文序列化走阶段 4 的持久化级 MarkdownCodec（portable 模式）；节点级策略见 `docs/architecture/markdown-compatibility.md`。

## 文件名冲突：确定性规则

同一目录下标题重名时确定性重命名：

```text
项目.md
项目 (2).md
项目 (3).md
```

约束：所有路径先整体确定，再统一生成 Markdown 中的相对链接——不能边创建文件边猜路径。同一输入多次导出必须产生确定性路径（阶段 7 验收标准）。

## Web 导入流程

```text
读取 manifest
→ 校验格式版本
→ 解析全部 Markdown
→ 建立 noteId/path 映射
→ 导入附件
→ 创建页面树
→ 原子创建正文
→ 建立标签关系
→ 重建搜索索引
→ 输出导入报告
```

「原子创建正文」指经 `DocumentWriteRepository.createWithContent`（INV-04）单事务写入页面与正文，不留空文档中间态。

## 导入报告字段

导入完成后向用户展示的报告至少包含：

- 成功文档数；
- 跳过文档数；
- 文件名冲突（重命名前后对照）；
- 无法识别语法（节点/语法清单）；
- 缺失附件；
- 无法解析链接；
- 数据格式版本；
- 是否发生有损转换。

有损转换发生时，受影响文档逐条列出，不静默覆盖。
