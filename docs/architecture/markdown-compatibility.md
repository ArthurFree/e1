# Markdown 兼容性矩阵（R005）

本文盘点当前编辑器全部节点/mark 类型的 Markdown 导入导出行为，并给出阶段 4（持久化级 MarkdownCodec）的目标序列化策略与有损处理约定。这是 DUAL-07 的对照表：**所有可持久化编辑器节点必须定义 Markdown 迁移策略**；新增节点时必须同步更新本表。

## 现状基线

- 文档 schema 唯一定义在 `src/editor/extensions.ts` 的 `buildDocumentExtensions()`，主编辑器与 Markdown 转换器（`src/editor/markdown.ts`）共用。
- 当前 Markdown 能力为模块级 headless 编辑器（`@tiptap/markdown`），提供 `markdownToJson()` / `jsonToMarkdown()` / `jsonToText()`，适合导入导出工具，但**不是持久化级 Codec**：不处理 Frontmatter、稳定 ID、相对链接、附件路径重写与无损回写检测（r005.md §一.3.3）。
- 现有行为由 `src/editor/markdown.test.ts` 锁定底层转换：标题/段落/行内格式、任务列表、代码块、表格可解析往返。文档级导出自 R005 阶段 4B 起经持久化级 MarkdownCodec（`src/application/markdown/documentExport.ts`）：`localImage`/`attachment` 序列化为相对路径引用，资源随 ZIP 包导出。

## 节点矩阵

| 节点                                         | 来源扩展                          | 当前导入行为                      | 当前导出行为                                                                       | 目标序列化策略（阶段 4）                                                                          | 有损处理约定                                  |
| -------------------------------------------- | --------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `paragraph`                                  | StarterKit                        | 标准段落解析                      | 标准段落                                                                           | 不变                                                                                              | 无损                                          |
| `heading`                                    | StarterKit（levels 1–6）          | `#`–`######`                      | `#`–`######`                                                                       | 不变                                                                                              | 无损                                          |
| `blockquote`                                 | StarterKit                        | `>` 引用                          | `>` 引用                                                                           | 不变                                                                                              | 无损                                          |
| `bulletList`/`orderedList`/`listItem`        | StarterKit                        | `-` / `1.` 列表                   | `-` / `1.` 列表                                                                    | 不变                                                                                              | 无损                                          |
| `taskList`/`taskItem`                        | TaskList/TaskItem（nested）       | `- [ ]` / `- [x]`（测试锁定）     | `- [ ]` / `- [x]`                                                                  | 不变                                                                                              | 无损                                          |
| `codeBlock`                                  | CodeBlockWithLanguage（lowlight） | ` ```lang ` 围栏（测试锁定）      | ` ```lang ` 围栏                                                                   | 语言 id 原样写入围栏；未知语言已在导入侧回退 `plaintext`（`normalizeCodeLanguage`）               | 无损                                          |
| `horizontalRule`                             | StarterKit                        | `---`                             | `---`                                                                              | 与 Frontmatter 分隔线歧义由 Codec 上下文区分                                                      | 无损                                          |
| `hardBreak`                                  | StarterKit                        | 行尾两空格/反斜杠                 | 行尾两空格/反斜杠                                                                  | 不变                                                                                              | 无损                                          |
| `table`/`tableRow`/`tableCell`/`tableHeader` | TableKit                          | 管道表格（测试锁定）              | 管道表格                                                                           | 不变；单元格内不支持的块级内容降级为纯文本                                                        | 单元格复杂内容降级时计入 `unsupported`        |
| `image`（旧 Base64）                         | Image（allowBase64 已关闭）       | `![](url)` 外部 URL 图片          | `![](src)`                                                                         | 仅兼容存量：src 为 `data:` 时不写入 Markdown（无法恢复），外部 URL 原样保留                       | data: 图片计入 `unsupported`                  |
| `localImage`                                 | LocalImage（R004 阶段 6）         | 不产生（`![](...)` 解析为 image） | **序列化为相对路径图片 `![alt](assets/<文件名>)`，二进制随 ZIP 包导出**（R005 4B） | **序列化为相对路径图片 `![alt](../assets/image.png)` + 二进制写入 `assets/`**；宽度和 alt 保留    | 附件缺失时占位并计入导入报告「缺失附件」      |
| `attachment`                                 | Attachment                        | 不产生                            | **序列化为相对路径链接 `[name](assets/<文件名>)`，二进制随 ZIP 包导出**（R005 4B） | 序列化为相对路径链接 `[name](../assets/file.pdf)` + 二进制写入 `assets/`                          | 同上                                          |
| `inlineMath`/`blockMath`                     | Mathematics                       | 未经 fixture 验证                 | 未经 fixture 验证                                                                  | `$...$` / `$$...$$`（KaTeX 兼容语法）；阶段 4 以 golden test 锁定                                 | 解析失败保留原始 `$` 文本，计入 `unsupported` |
| `mention`（@ 页面提及）                      | Mention（转换器已注册）           | 未经 fixture 验证                 | 未经 fixture 验证                                                                  | portable 模式序列化为相对 Markdown 链接 `[标题](../目录/标题.md)`；plain 模式降级为纯文本 `@标题` | 目标页面不在导出集内时降级纯文本              |

## Mark 矩阵

| Mark                          | 来源扩展               | 当前导入行为      | 当前导出行为       | 目标序列化策略                                             | 有损处理约定                                             |
| ----------------------------- | ---------------------- | ----------------- | ------------------ | ---------------------------------------------------------- | -------------------------------------------------------- |
| `bold`                        | StarterKit             | `**...**`         | `**...**`          | 不变                                                       | 无损                                                     |
| `italic`                      | StarterKit             | `*...*`           | `*...*`            | 不变                                                       | 无损                                                     |
| `strike`                      | StarterKit             | `~~...~~`         | `~~...~~`          | 不变                                                       | 无损                                                     |
| `code`                        | StarterKit             | `` `...` ``       | `` `...` ``        | 不变                                                       | 无损                                                     |
| `link`                        | StarterKit（autolink） | `[t](url)`        | `[t](url)`         | 库内相对链接解析为页面引用；外部 URL 原样                  | 无法解析的相对链接保留原样并计入导入报告「无法解析链接」 |
| `underline`                   | StarterKit             | CommonMark 无语法 | 样式丢失（纯文本） | plain 模式接受丢失；portable 模式可用 `<u>` 内联 HTML 保留 | 计入 `unsupported`（plain 模式豁免）                     |
| `highlight`（multicolor）     | Highlight              | 无语法            | 样式丢失           | portable 模式用 `==文字==`（无底色语义时）或 `<mark>` 保留 | 同上                                                     |
| `textStyle`（color/fontSize） | TextStyleKit           | 无语法            | 样式丢失           | 颜色/字号为 Web 增强样式，Markdown 不保留                  | 计入 `unsupported`，正文本体不受影响                     |
| `subscript`/`superscript`     | Sub/Sup 扩展           | 无语法            | 样式丢失           | portable 模式用 `<sub>`/`<sup>` 保留                       | 同上                                                     |

## 块级属性矩阵

| 属性            | 载体              | 当前行为         | 目标策略                                        | 有损处理约定                         |
| --------------- | ----------------- | ---------------- | ----------------------------------------------- | ------------------------------------ |
| `textAlign`     | heading/paragraph | 导出后丢失       | Markdown 不保留对齐                             | 计入 `unsupported`，正文本体不受影响 |
| `indent`（0–8） | paragraph/heading | 导出后丢失       | Markdown 不保留缩进；列表层级由列表嵌套本身表达 | 同上                                 |
| `language`      | codeBlock         | 围栏语言 id 往返 | 不变                                            | 无损                                 |

## 重点：localImage 现状与阶段 4 目标

**历史现状（R004 阶段 6 决策）**：`localImage` 与 `attachment` 在 Markdown 导出时**完全不序列化——节点被静默丢弃**（`markdown.test.ts` 锁定：输出不含 `![` 与 `attachment:`）。当初的理由是避免导出 `![](attachment:id)` 这种重新导入后无法渲染的伪引用。代价是：**当时的 Markdown 导出不是完整可迁移备份**，正文中的图片与附件在导出物中消失。

**R005 阶段 4B 已落地（当前行为）**：文档级导出经 `exportDocumentMarkdown`（`src/application/markdown/documentExport.ts`）编排——文档含图片/附件时产出 `标题.zip`（`标题.md` + `assets/…`，ZIP 为手写最小 STORED writer，`src/application/services/zip.ts`），Markdown 经 codec portable 模式序列化为 `![alt](assets/<文件名>)` / `[name](assets/<文件名>)`；无资源引用时维持单 `.md` 导出（plain 模式、无 Frontmatter）。文件名冲突按 `name (2).ext` 确定性递增；附件记录缺失时降级为可见占位文本并计入 unsupported（`missing-asset`）；有损转换经结果对象携带并在调用处 console.warn（导出入口暂无 UI 通知通道）。Markdown 导出不再丢失图片与附件。

**阶段 4 目标（Portable Vault，阶段 7）**：持久化级 MarkdownCodec 的 portable 模式必须做到——

- `localImage` → `![alt](../assets/<文件名>)`，二进制写入 Vault `assets/`；
- `attachment` → `[name](../assets/<文件名>)`，二进制写入 `assets/`；
- 路径经 `MarkdownAssetResolver` 统一生成，文件名冲突走确定性规则（`docs/architecture/portable-vault.md`）；
- 导入反向解析相对路径，重建附件记录与节点。

## 有损/不支持处理总约定

1. 解析或序列化遇到无法安全转换的内容时，Codec 返回 `{ lossy: true, unsupported: [...] }`，**不静默删除**（r005.md §九）。
2. Desktop 侧：用户必须明确确认后才允许有损结果覆盖原 Markdown。
3. Web 导入侧：有损条目逐条进入导入报告（字段见 `docs/architecture/portable-vault.md`）。
4. 上表中标注「未经 fixture 验证」的条目（mathematics、mention），阶段 4 必须以 `fixtures/markdown/` golden test 锁定真实行为后再定稿策略。
