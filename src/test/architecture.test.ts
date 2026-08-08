/**
 * 架构约束测试（R003 阶段 5/§8.2）：用源码扫描代替 ESLint 强制分层规则。
 *
 * 规则：
 * - components / state / editor / application / domain 不得 import infrastructure；
 * - domain 不得 import react；
 * - application 不得 import components。
 *
 * 扫描经 import.meta.glob（Vite 原生，无需 node:fs）实现；
 * 排除测试文件（*.test.*）与测试基建（src/test/）；违规即失败并附文件与行号。
 */
import { describe, expect, it } from "vitest";

const sources = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** 生产源码条目：排除测试文件与测试基建目录。 */
const entries = Object.entries(sources).filter(
  ([path]) => !path.includes(".test.") && !path.startsWith("../test/"),
);

interface Violation {
  file: string;
  line: number;
  text: string;
}

function findImports(
  file: string,
  content: string,
  pattern: RegExp,
): Violation[] {
  const out: Violation[] = [];
  content.split("\n").forEach((text, index) => {
    if (/^\s*import\s/.test(text) && pattern.test(text)) {
      out.push({ file, line: index + 1, text: text.trim() });
    }
  });
  return out;
}

function scan(prefixes: string[], pattern: RegExp): Violation[] {
  return entries
    .filter(([path]) => prefixes.some((p) => path.startsWith(`../${p}/`)))
    .flatMap(([path, content]) => findImports(path, content, pattern));
}

function format(violations: Violation[]): string {
  return violations.map((v) => `  ${v.file}:${v.line}  ${v.text}`).join("\n");
}

describe("架构分层约束", () => {
  it("components/state/editor/application/domain 不得 import infrastructure", () => {
    const violations = scan(
      ["components", "state", "editor", "application", "domain"],
      /infrastructure\//,
    );
    expect(format(violations)).toBe("");
    expect(violations).toEqual([]);
  });

  it("domain 不得 import react", () => {
    const violations = scan(["domain"], /from\s+["']react["']/);
    expect(format(violations)).toBe("");
    expect(violations).toEqual([]);
  });

  it("application 不得 import components", () => {
    const violations = scan(["application"], /components\//);
    expect(format(violations)).toBe("");
    expect(violations).toEqual([]);
  });

  /**
   * R004 §4.6：components 不得使用聚合 hook（useWorkspaceSession /
   * useNavigation），一律按需订阅数据/命令细粒度 hook，避免无关
   * 订阅导致的重渲染回潮。
   */
  it("components 不得使用聚合状态 hook（R004 §4.6）", () => {
    const pattern = /\b(useWorkspaceSession|useNavigation)\s*\(/;
    const violations: Violation[] = [];
    for (const [path, content] of entries) {
      if (!path.startsWith("../components/")) continue;
      content.split("\n").forEach((text, index) => {
        if (pattern.test(text)) {
          violations.push({ file: path, line: index + 1, text: text.trim() });
        }
      });
    }
    expect(format(violations)).toBe("");
    expect(violations).toEqual([]);
  });

  /**
   * R005 批次 2（阶段 1 / DUAL-02）：components/state 不得 import
   * domain/repositories——type-only import 同样违规（与上方
   * infrastructure 规则同判定：import 行匹配即计）。仓储只经构造
   * 函数注入 application 服务，UI/状态层一律经 commands/queries。
   */
  it("components/state 不得 import domain/repositories（R005 批次 2）", () => {
    const violations = scan(["components", "state"], /domain\/repositories/);
    expect(format(violations)).toBe("");
    expect(violations).toEqual([]);
  });

  /**
   * R005 批次 2：components/state 不得访问已从 AppServices 移除的原始
   * 仓储/服务字段——属性访问（services.xxx）与 useAppServices() 解构
   * 两种形态都拦截，编排一律经 services.commands / services.queries /
   * services.preferencesService。
   * attachment 为例外（保留在 AppServices 上）：经 editor.storage 通道
   * 供 Tiptap 附件扩展读取，阶段 5 Asset 抽象后移除（TODO(R005-13/14)）。
   */
  it("components/state 不得访问 AppServices 已移除的原始仓储字段（R005 批次 2）", () => {
    const REMOVED =
      "workspace|page|content|revision|tag|preferences|documentWrite|documentCommit|session|searchIndex";
    const propertyAccess = new RegExp(`services\\.(${REMOVED})\\b`);
    const destructuring = new RegExp(
      `\\{[^}]*\\b(?:${REMOVED})\\b[^}]*\\}\\s*=\\s*useAppServices\\(\\)`,
    );
    const violations: Violation[] = [];
    for (const [path, content] of entries) {
      if (!path.startsWith("../components/") && !path.startsWith("../state/"))
        continue;
      content.split("\n").forEach((text, index) => {
        if (propertyAccess.test(text) || destructuring.test(text)) {
          violations.push({ file: path, line: index + 1, text: text.trim() });
        }
      });
    }
    expect(format(violations)).toBe("");
    expect(violations).toEqual([]);
  });

  /**
   * R004 INV-07 基线：components 不得直接调用正文/版本/附件/页面写仓储。
   * 阶段 0 以白名单快照记录现存 8 处直写点（见
   * docs/architecture/document-write-path.md），新增违规立即失败；
   * 阶段 3 迁移时同步收缩白名单，现已清零。
   */
  it("components 直写仓储仅限白名单快照（R004 阶段 3 清零）", () => {
    const pattern =
      /services\.(content\.save|revision\.add|attachment\.(?:add|remove|removeOrphans)|page\.create)/;
    const violations: string[] = [];
    for (const [path, content] of entries) {
      if (!path.startsWith("../components/")) continue;
      content.split("\n").forEach((text) => {
        const match = text.match(pattern);
        if (match) {
          violations.push(`${path} services.${match[1]}`);
        }
      });
    }
    violations.sort();
    expect(violations).toEqual([]);
  });

  /**
   * R005 阶段 2（Bootstrap 拆分）：仅 Web 装配根（main.web.tsx）与
   * platform/web 允许 import infrastructure/browserServices，防止
   * UI/状态层回流直接装配；测试基建（src/test/，glob 下为 ./ 前缀）
   * 与 *.test.* 豁免——TestApp 经 fake-indexeddb 用生产容器属既有惯例。
   */
  it("仅 main.web.tsx 与 platform/web 允许 import infrastructure/browserServices（R005 阶段 2）", () => {
    const violations: Violation[] = [];
    for (const [path, content] of entries) {
      if (
        path === "../main.web.tsx" ||
        path.startsWith("../platform/web/") ||
        path.startsWith("./")
      )
        continue;
      violations.push(
        ...findImports(path, content, /infrastructure\/browserServices/),
      );
    }
    expect(format(violations)).toBe("");
    expect(violations).toEqual([]);
  });

  /**
   * R005 阶段 2：bootstrap 为平台无关的共享挂载入口，不得 import
   * infrastructure；平台差异只经 AppServices 容器注入。
   */
  it("bootstrap 不得 import infrastructure（R005 阶段 2）", () => {
    const violations = scan(["bootstrap"], /infrastructure\//);
    expect(format(violations)).toBe("");
    expect(violations).toEqual([]);
  });
});
