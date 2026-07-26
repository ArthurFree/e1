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
});
