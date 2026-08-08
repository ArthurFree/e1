# 依赖规则

## 规则清单

| 规则                                                                                                                                              | 说明                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `src/components/**` 不得 import `src/infrastructure/**`                                                                                           | UI 只经 AppServices 容器与状态层取数                                                                                  |
| `src/state/**` 不得 import `src/infrastructure/**`                                                                                                | 状态层经 `useAppServices()` 取服务                                                                                    |
| `src/editor/**` 不得 import `src/infrastructure/**`                                                                                               | 编辑器内核不知道 IndexedDB 的存在                                                                                     |
| `src/application/**` 不得 import `src/infrastructure/**`、`src/components/**`                                                                     | 应用服务只依赖 domain port                                                                                            |
| `src/domain/**` 不得 import `src/infrastructure/**`、`react`                                                                                      | 领域层纯逻辑、零框架依赖                                                                                              |
| `src/infrastructure/**` 可实现/依赖 domain 与 application                                                                                         | 装配根（`browserServices.ts`）是唯一汇合点                                                                            |
| `src/components/**`、`src/state/**` 不得 import `domain/repositories`（type-only 同样违规）                                                       | 仓储只经构造函数注入 application 服务；UI/状态层一律经 commands/queries（DUAL-02，R005 阶段 1）                       |
| `src/components/**`、`src/state/**` 不得访问 AppServices 已移除的原始仓储/服务字段                                                                | 编排一律经 `services.commands` / `services.queries` / `services.preferencesService`（attachment 为例外，R005 阶段 1） |
| 仅 `src/main.web.tsx` 与 `src/platform/web/**` 可 import `infrastructure/browserServices`；`src/bootstrap/**` 不得 import `src/infrastructure/**` | 装配链唯一（DUAL-01，R005 阶段 2），防止 UI/状态层回流直接装配                                                        |

## 强制方式

规则由 `src/test/architecture.test.ts` 强制：用 `import.meta.glob` 扫描全部生产源码（排除测试文件与 `src/test/`），逐行匹配 import 语句（含属性访问与解构两种形态），任一违规即测试失败并附文件与行号。`npm test` 全量运行时自动执行；分层与循环依赖另由 dependency-cruiser（`npm run deps:check`）兜底。

## 注入机制

- **AppServices 容器**（`src/application/AppServices.ts`，R005 阶段 1 收紧）：业务编排入口为 `commands{workspace,page,tag,document}` 四个命令服务与 `queries{workspace,document,search}` 三个查询服务，外加 `preferencesService` 单例、AI provider 工厂、保存协调器工厂、同步频道/存储事件与 `capabilities` 能力矩阵；原始仓储与 documentCommit/session/searchIndex 不再公开（attachment 为例外，经 editor.storage 通道保留，TODO R005-13/14）。
- **装配链**（R005 阶段 2，DUAL-01）：`main.web.tsx`（唯一 Web 装配根）→ `platform/web/createWebRuntime`（构造 `createBrowserAppServices` 容器 + Web 能力矩阵）→ `bootstrap/mountApplication`（平台无关共享挂载，注入 `AppServicesProvider`）；测试可注入 `src/infrastructure/memory/` 的内存实现（可替换性证明）。
- **Tiptap 扩展例外通道**：Tiptap 扩展在 `buildEditorExtensions` 静态装配，无法直接读 React Context；附件仓储经 `editor.storage.attachmentRepository` 注入（`DocumentEditor` 装配时写入，`editor/attachment.ts` 经 `getAttachmentRepository(editor)` 读取）。这是唯一非 Context 的注入通道，使用时必须在注释中说明。

## 历史背景

R003 之前 UI 与状态层直接 import 仓储单例，「可替换基础设施层」只是名义目标。阶段 5 建立容器后，14 个生产文件全部迁离 infrastructure 直接导入，内存仓储可运行 AppProvider 全流程（`src/state/AppState.memory.test.tsx`）。
