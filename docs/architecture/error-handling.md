# 错误处理

## 领域错误码（`src/domain/errors.ts`）

仓储层与领域纯函数统一抛 `DomainError`：`code` 是稳定契约（程序判断），`message` 是中文用户文案（UI 不得解析文案判断错误类型）。

| code                     | 含义                                 |
| ------------------------ | ------------------------------------ |
| `WORKSPACE_NOT_FOUND`    | 知识库不存在或数据损坏               |
| `PAGE_NOT_FOUND`         | 页面不存在或数据损坏（含已永久删除） |
| `PARENT_NOT_FOUND`       | 父页面不存在                         |
| `CROSS_WORKSPACE_PARENT` | 父页面属于其他知识库                 |
| `PAGE_TREE_CYCLE`        | 移动会形成树环                       |
| `PARENT_IN_TRASH`        | 父页面在回收站中                     |
| `TAG_NOT_FOUND`          | 标签不存在                           |
| `CROSS_WORKSPACE_TAG`    | 标签与页面属于不同知识库             |
| `INVALID_INPUT`          | 入参非法（kind、标题长度等）         |
| `CORRUPTED_DOCUMENT`     | 文档正文 JSON 损坏                   |

## 正文 JSON 运行时校验（R003 阶段 4）

`src/domain/validation/documentContent.ts`：

- `parseDocumentContent(raw)`：白名单严格校验（节点/标记类型、content 数组、text 仅文本节点、attrs 形状、attachment/mention/image 关键字段），损坏返回 `CORRUPTED_DOCUMENT` 结果；白名单与编辑器 schema 的同步由测试强制。
- `sanitizeDocumentContent(raw)`：尽力修复——剔除非法节点/标记、提升可保留的子内容，返回恒为合法的 doc。

## 损坏正文 UI 流程

1. 加载文档时校验失败：**不渲染编辑器**（防白屏），原始 JSON 写入 `localStorage` 诊断记录；
2. 损坏面板提供三个选项：**尝试恢复**（sanitize 结果进编辑器并立即保存）、**导出原始 JSON**（下载排查）、**创建空白副本**（覆盖为合法空文档）；
3. 版本历史中的损坏版本：拒绝恢复并提示，不改动编辑器与存储；
4. 恢复缓冲读取同样过白名单校验，坏数据直接清除。

## 应用层错误约定

- 不伪造成功：保存失败进 error 态、保留内容、提供重试；
- 不允许无故 `.catch(() => undefined)`；异步写入错误必须可观测（偏好写入经 `routePersistenceStatus`，其余经 `console.error`）；
- 未处理的 Promise rejection 视为缺陷（`PreferencesRace` 等测试覆盖）。

## 开发诊断（R003 阶段 8）

`src/application/devDiagnostics.ts`：仅开发环境输出（生产/测试默认静默）的指标——`workspace-load`、`search-query`、`save-queue`、`idb-save`、`db-migration`、`corrupted-content`。只记录指标名、毫秒数与计数/标识符，**不记录文档正文、API Key、AI 请求内容**。
