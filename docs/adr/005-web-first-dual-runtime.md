# ADR 005：Web 优先与双运行时

## 背景

项目此前是明确的单 Web 运行时：`main.tsx` 直接装配 `createBrowserAppServices()`（IndexedDB / localStorage / BroadcastChannel），没有独立的 Web/Desktop Bootstrap，也没有 Electron 入口（阶段 1–2 已落地：编排下沉 `application/commands` 与 `application/queries`，装配链拆分为 `main.web.tsx` → `platform/web/createWebRuntime` → `bootstrap/mountApplication`）。与此同时，若干底层实现已阻碍未来的桌面化：React Provider 仍编排持久化业务、搜索索引是 Web 内存实现、Markdown 只是导入导出工具（`localImage` 导出时被丢弃）、附件领域模型直接含 `Blob`、恢复/同步/设置均为浏览器实现（r005.md §一）。既不能立刻开发完整 Electron，也不能继续以「纯 Web、以后再改」的方式增加底层功能。

## 决策

- **Web 继续作为唯一正式交付端**：阶段 0~8 全部为 Web 正式版本迭代，阶段 9 才做 Electron 技术验证版，阶段 10 根据验证结果决定是否产品化；
- **所有新底层能力按双运行时设计**：新增编辑器节点、数据实体、平台功能、存储操作、搜索字段、附件能力必须遵守 r005.md §十六的开发规则，平台差异一律经 `RuntimeCapabilities` 判断，禁止平台名分支（DUAL-01）；
- **架构准备先于 Electron 验证**：阶段 1~8 的启动条件（Provider 不访问仓储、Bootstrap 分离、版本 token、MarkdownCodec、Asset/Search 抽象、Portable Vault、平台服务抽象）全部满足后才进入阶段 9；阶段 9 之前不引入 SQLite、文件监听、安装器、签名与自动更新；
- 四层运行时边界（Shared UI / Shared Application / Web Runtime / Desktop Runtime）与 DUAL-01~09 不变量作为强制约束，见 `docs/architecture/runtime-boundaries.md`。

## 原因

- 最优先的不是 Electron Shell，而是把仓储编排移出 Provider、拆分 Bootstrap、建设持久化级 MarkdownCodec、建立 Portable Vault——这四项直接改善当前 Web 架构与导入导出质量，Web 用户立即受益；
- 按双运行时设计的新底层能力避免 Electron 改造演变成第二套项目；
- Electron 技术验证推迟到架构边界稳定之后，避免在错误的抽象上投入主进程、IPC 与打包成本。

## 结果

- 阶段 0 交付六篇基线文档与 `src/runtime/RuntimeCapabilities.ts`，Web 构建与行为完全不变；
- 阶段 1 交付 `application/commands/`（四命令服务，回收站并入 PageCommandService）与 `application/queries/`（三查询服务），AppServices 不再暴露原始仓储，Provider 只持状态生命周期（DUAL-02）；
- 阶段 2 交付 Bootstrap 拆分：`bootstrap/mountApplication` 共享挂载 + `platform/web/createWebRuntime` + `main.web.tsx` 唯一 Web 装配根，`RuntimeCapabilities` 接入 `AppServices.capabilities`（Web 六能力全 false）；
- 阶段路线与优先级见 `docs/requirements/r005-web-first-dual-runtime.md`；
- 被否决的替代方案：立刻开发完整 Electron（架构边界未稳定，成本高且会分叉）、继续纯 Web 日后再改（底层债务累积，桌面化时返工更大）。
