# 依赖规则

## 规则清单

| 规则                                                                                                                                              | 说明                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `src/components/**` 不得 import `src/infrastructure/**`                                                                                           | UI 只经 AppServices 容器与状态层取数                                                                                        |
| `src/state/**` 不得 import `src/infrastructure/**`                                                                                                | 状态层经 `useAppServices()` 取服务                                                                                          |
| `src/editor/**` 不得 import `src/infrastructure/**`                                                                                               | 编辑器内核不知道 IndexedDB 的存在                                                                                           |
| `src/application/**` 不得 import `src/infrastructure/**`、`src/components/**`                                                                     | 应用服务只依赖 domain port                                                                                                  |
| `src/domain/**` 不得 import `src/infrastructure/**`、`react`                                                                                      | 领域层纯逻辑、零框架依赖                                                                                                    |
| `src/components/**`、`src/state/**`、`src/editor/**`、`src/application/**`、`src/domain/**` 不得 import `src/platform/web/persistence/**`         | Web 持久化实现（IndexedDB）是平台适配器，只经 AppServices 注入的 domain port 访问（PR6）                                    |
| `src/platform/web/**`、`src/platform/desktop/**` 可实现/依赖 domain 与 application                                                                | 平台适配层是唯一汇合点；Web 装配根为 `platform/web/createBrowserServices.ts`（PR6）                                         |
| `src/components/**`、`src/state/**` 不得 import `domain/repositories`（type-only 同样违规）                                                       | 仓储只经构造函数注入 application 服务；UI/状态层一律经 commands/queries（DUAL-02，R005 阶段 1）                             |
| `src/components/**`、`src/state/**` 不得访问 AppServices 已移除的原始仓储/服务字段                                                                | 编排一律经 `services.commands` / `services.queries` / `services.preferencesService`（attachment 例外已于 R005 阶段 5 移除） |
| `src/editor/**` 不得 import `domain/repositories`                                                                                                 | 附件资源存储只经 `editor.storage.assetServices` 注入的服务组访问（R005 阶段 5）                                             |
| 仅 `src/main.web.tsx` 与 `src/platform/web/**` 可 import `platform/web/createBrowserServices`；`src/bootstrap/**` 不得 import 任何平台实现 | 装配链唯一（DUAL-01，R005 阶段 2），防止 UI/状态层回流直接装配                                                              |

## 强制方式

两套门禁分工明确，**不再互相重复**（PR6）：

- **纯分层依赖规则**由 dependency-cruiser（`.dependency-cruiser.js`，`npm run deps:check`）强制。它基于真实模块解析，能识别深层路径、type-only import 与循环依赖，是上表前七行的唯一来源（规则名：`no-circular`、`domain-isolated`、`domain-no-react`、`application-no-ui-no-infra`、`ui-no-infrastructure`、`ui-no-web-persistence`、`electron-no-src`、`src-no-electron`）。
- **模块解析看不见的行为不变量**由 `src/test/architecture.test.ts` 强制：用 `import.meta.glob` 扫描全部生产源码（排除测试文件与 `src/test/`）逐行匹配——禁用标识符（`desktopExtras` / `window.e1` / `isElectron` / `process.platform` / `localStorage` / `absolutePath` 等）、AppServices 已移除字段的属性访问与解构、聚合状态 hook、装配根白名单、Desktop 写入路径单点。`npm test` 全量运行时自动执行。

## 注入机制

- **AppServices 容器**（`src/application/AppServices.ts`，R005 阶段 1 收紧）：业务编排入口为 `commands{workspace,page,tag,document}` 四个命令服务与 `queries{workspace,document,search}` 三个查询服务，外加 `preferencesService` 单例、`assets` 资源服务组（R005 阶段 5：AssetCommandService/AssetAccessService/AssetPicker/NotificationService）、AI provider 工厂、保存协调器工厂、同步频道/存储事件与 `capabilities` 能力矩阵；原始仓储与 documentCommit/session/searchIndex 不再公开（阶段 5 起 attachment 例外字段已删除）。
- **装配链**（R005 阶段 2，DUAL-01）：`main.web.tsx`（唯一 Web 装配根）→ `platform/web/createWebRuntime` → `platform/web/createBrowserServices`（构造 `createBrowserAppServices` 容器，仓储取自 `platform/web/persistence/`）→ `bootstrap/mountApplication`（平台无关共享挂载，注入 `AppServicesProvider`）；测试可注入 `src/infrastructure/memory/` 的内存实现（可替换性证明）。
- **Tiptap 扩展例外通道**：Tiptap 扩展在 `buildEditorExtensions` 静态装配，无法直接读 React Context；资源服务组经 `editor.storage.assetServices` 注入（R005 阶段 5，原 `attachmentRepository` 通道；`DocumentEditor` 装配时写入 `services.assets`，`editor/attachment.ts` 经 `getAssetServices(editor)` 读取，当前文档 ID 走 `editor.storage.attachmentPageId`）。这是唯一非 Context 的注入通道，使用时必须在注释中说明。

## 历史背景

R003 之前 UI 与状态层直接 import 仓储单例，「可替换基础设施层」只是名义目标。阶段 5 建立容器后，14 个生产文件全部迁离 infrastructure 直接导入，内存仓储可运行 AppProvider 全流程（`src/state/AppState.memory.test.tsx`）。
