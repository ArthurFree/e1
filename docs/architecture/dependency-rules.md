# 依赖规则

## 规则清单

| 规则 | 说明 |
| --- | --- |
| `src/components/**` 不得 import `src/infrastructure/**` | UI 只经 AppServices 容器与状态层取数 |
| `src/state/**` 不得 import `src/infrastructure/**` | 状态层经 `useAppServices()` 取服务 |
| `src/editor/**` 不得 import `src/infrastructure/**` | 编辑器内核不知道 IndexedDB 的存在 |
| `src/application/**` 不得 import `src/infrastructure/**`、`src/components/**` | 应用服务只依赖 domain port |
| `src/domain/**` 不得 import `src/infrastructure/**`、`react` | 领域层纯逻辑、零框架依赖 |
| `src/infrastructure/**` 可实现/依赖 domain 与 application | 装配根（`browserServices.ts`）是唯一汇合点 |

## 强制方式

项目无 ESLint 依赖，规则由 `src/test/architecture.test.ts` 强制：用 `import.meta.glob` 扫描全部生产源码（排除测试文件与 `src/test/`），逐行匹配 import 语句，任一违规即测试失败并附文件与行号。`npm test` 全量运行时自动执行。

## 注入机制

- **AppServices 容器**（`src/application/AppServices.ts`）：7 个仓储 port + 会话加载服务 + 搜索索引 + AI provider 工厂 + 保存协调器工厂。
- **装配根**：生产 `src/infrastructure/browserServices.ts`（IndexedDB 实现），在 `main.tsx` 注入 `AppServicesProvider`；测试可注入 `src/infrastructure/memory/` 的内存实现（可替换性证明）。
- **Tiptap 扩展例外通道**：Tiptap 扩展在 `buildEditorExtensions` 静态装配，无法直接读 React Context；附件仓储经 `editor.storage.attachmentRepository` 注入（`DocumentEditor` 装配时写入，`editor/attachment.ts` 经 `getAttachmentRepository(editor)` 读取）。这是唯一非 Context 的注入通道，使用时必须在注释中说明。

## 历史背景

R003 之前 UI 与状态层直接 import 仓储单例，「可替换基础设施层」只是名义目标。阶段 5 建立容器后，14 个生产文件全部迁离 infrastructure 直接导入，内存仓储可运行 AppProvider 全流程（`src/state/AppState.memory.test.tsx`）。
