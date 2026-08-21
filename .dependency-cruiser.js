/**
 * 分层依赖约束（R004 §7.5；PR6 起为分层规则的唯一来源）：基于真实模块
 * 解析，能识别循环依赖与经深层路径的越层引用。
 *
 * src/test/architecture.test.ts 不再重复声明分层规则，只保留模块解析
 * 看不见的行为不变量（禁用标识符、装配根白名单、AppServices 已删字段等）。
 *
 * 测试文件（*.test.*、src/test/）豁免生产分层规则。
 */

/** 测试与基建文件：不参与生产分层约束。 */
const TEST_LIKE =
  "(\\.test\\.[^.]+$|\\.(spec|contract)\\.[^.]+$|^src/test/|\\.test-helper)";

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: "no-circular",
      comment: "禁止循环依赖（含间接）",
      severity: "error",
      from: { pathNot: TEST_LIKE },
      to: { circular: true },
    },
    {
      name: "domain-isolated",
      comment:
        "domain 不依赖任何上层（application/editor/state/components/infrastructure）",
      severity: "error",
      from: { path: "^src/domain", pathNot: TEST_LIKE },
      to: {
        path: "^src/(application|editor|state|components|infrastructure)",
      },
    },
    {
      name: "application-no-ui-no-infra",
      comment: "application 不依赖 components/state/infrastructure",
      severity: "error",
      from: { path: "^src/application", pathNot: TEST_LIKE },
      to: { path: "^src/(components|state|infrastructure)" },
    },
    {
      name: "domain-no-react",
      comment:
        "domain 为纯逻辑层，不得依赖 react（原由 architecture.test.ts 强制，PR6 迁入）",
      severity: "error",
      from: { path: "^src/domain", pathNot: TEST_LIKE },
      to: { path: "node_modules/(@types/)?react(-dom)?/" },
    },
    {
      name: "ui-no-infrastructure",
      comment:
        "components/state/editor 不直接依赖 infrastructure（含深层路径）；infrastructure（内存仓储 / AI provider / id）只能由装配根（platform/** / 测试）引用",
      severity: "error",
      from: {
        path: "^src/(components|state|editor)",
        pathNot: TEST_LIKE,
      },
      to: { path: "^src/infrastructure" },
    },
    {
      name: "ui-no-web-persistence",
      comment:
        "PR6：components/state/editor/application/domain 不直接依赖 Web 持久化实现（src/platform/web/persistence，IndexedDB）——只经 AppServices 容器注入的 domain port 访问",
      severity: "error",
      from: {
        path: "^src/(components|state|editor|application|domain)",
        pathNot: TEST_LIKE,
      },
      to: { path: "^src/platform/web/persistence" },
    },
    {
      name: "electron-no-src",
      comment:
        "R006 阶段 1：electron 不得依赖 src（Main/Preload 与 Renderer 只经 shared/ 共享契约）",
      severity: "error",
      from: { path: "^electron" },
      to: { path: "^src" },
    },
    {
      name: "src-no-electron",
      comment:
        "R006 阶段 1：src 不得依赖 electron（桌面能力只经 platform/desktop + shared/ 契约）。" +
        "唯一豁免：R008 Stage 4 的 Main 侧全文搜索契约测试（双实现契约要求" +
        "同一套件驱动 Main 真实实现，@vitest-environment node 真实 node:sqlite）",
      severity: "error",
      from: {
        path: "^src",
        pathNot:
          "^src/test/desktopFullTextSearch\\.contract\\.test\\.ts$",
      },
      to: { path: "^electron" },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: "tsconfig.json",
    },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
    reporterOptions: {
      text: {
        highlightFocused: true,
      },
    },
  },
};
