# ADR 004：应用层与服务容器

## 背景

R003 之前，14 个生产文件直接 import IndexedDB 仓储单例，「可替换基础设施层」只是名义目标；AppState 单 Context 也承载过多职责。

## 决策

- 建立 `AppServices` 服务容器（7 个仓储 port + 会话加载 + 搜索索引 + AI/保存协调器工厂），经 `AppServicesProvider` 注入；生产装配根 `createBrowserAppServices()`，测试/可替换性证明用 `infrastructure/memory/` 内存仓储；
- **不**按 R003 §5.2 建议另建 25 个 use-case 类——用例编排由 AppState actions 与 application 服务（SaveCoordinator / WorkspaceSessionService / PreferencesService）承载；
- 分层依赖规则用 vitest 源码扫描（`src/test/architecture.test.ts`）强制，不引入 ESLint；
- Tiptap 扩展经 `editor.storage` 通道取仓储（唯一非 Context 注入通道）。

## 原因

- 容器 + port 已达成「IndexedDB 可整体替换」的验收（AppProvider 全流程可在内存仓储上运行）；同义 use-case 类是投机性重复；
- 项目无 ESLint 依赖，扫描测试以零新依赖覆盖同等约束。

## 结果

- components/state/editor/application/domain 均不再 import infrastructure；
- 被否决的替代方案：完整 use-case 类目录（与 AppState actions 重复）、引入 ESLint no-restricted-imports（新增工具链成本大于收益）。
