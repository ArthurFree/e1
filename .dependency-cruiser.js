/**
 * 分层依赖约束（R004 §7.5），与 src/test/architecture.test.ts 的源码扫描互补：
 * 这里基于真实模块解析，能识别循环依赖与经深层路径的越层引用。
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
      name: "ui-no-infrastructure",
      comment:
        "components/state/editor 不直接依赖 infrastructure（含深层路径）；infrastructure 只能由装配根（main.web.tsx / platform/web / infrastructure 自身 / 测试）引用",
      severity: "error",
      from: {
        path: "^src/(components|state|editor)",
        pathNot: TEST_LIKE,
      },
      to: { path: "^src/infrastructure" },
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
