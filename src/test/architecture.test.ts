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
   * R004 INV-07 基线：components 不得直接调用正文/版本/附件/页面写仓储。
   * 阶段 0 以白名单快照记录现存 8 处直写点（见
   * docs/architecture/document-write-path.md），新增违规立即失败；
   * 阶段 3 迁移时同步收缩白名单直至清零。
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
    expect(violations).toEqual([
      "../components/AIDraftModal.tsx services.content.save",
      "../components/AIDraftModal.tsx services.page.create",
      "../components/MainArea.tsx services.content.save",
      "../components/PageTreeSidebar.tsx services.content.save",
      "../components/TemplateCenter.tsx services.content.save",
      "../components/TemplateCenter.tsx services.page.create",
      "../components/VersionPanel.tsx services.content.save",
      "../components/VersionPanel.tsx services.revision.add",
    ]);
  });
});
