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
   * R005 阶段 5：attachment 字段同步移除（原 editor.storage 通道例外），
   * 附件能力一律经 services.assets（AssetServices 组）。
   */
  it("components/state 不得访问 AppServices 已移除的原始仓储字段（R005 批次 2）", () => {
    const REMOVED =
      "workspace|page|content|revision|attachment|tag|preferences|documentWrite|documentCommit|session|searchIndex";
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
   * R004 INV-07 基线：components 不得直接调用正文/版本/页面写仓储。
   * 阶段 0 以白名单快照记录现存 8 处直写点（见
   * docs/architecture/document-write-path.md），新增违规立即失败；
   * 阶段 3 迁移时同步收缩白名单，现已清零；R005 阶段 5 起附件写编排
   * 经 services.assets.commands（AssetCommandService），直写条目移除。
   */
  it("components 直写仓储仅限白名单快照（R004 阶段 3 清零）", () => {
    const pattern = /services\.(content\.save|revision\.add|page\.create)/;
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
   * R005 阶段 5：editor 不得 import domain/repositories——附件资源存储
   * （AssetStore）只经 editor.storage.assetServices 注入的服务组访问，
   * 编辑器扩展不直接依赖任何仓储 port（与 components/state 同约束）。
   */
  it("editor 不得 import domain/repositories（R005 阶段 5）", () => {
    const violations = scan(["editor"], /domain\/repositories/);
    expect(format(violations)).toBe("");
    expect(violations).toEqual([]);
  });

  /**
   * R005 阶段 6：application 不得 import 搜索索引具体实现——搜索只经
   * SearchIndexPort（application/services/SearchIndexPort）注入，
   * Web 内存实现（platform/web/search/BrowserMemorySearchIndex）与
   * 未来 Desktop SQLite 实现可整体替换，业务层不感知。
   */
  it("application 不得 import 搜索索引具体实现（R005 阶段 6）", () => {
    const violations = scan(
      ["application"],
      /platform\/web\/search|SearchIndexService/,
    );
    expect(format(violations)).toBe("");
    expect(violations).toEqual([]);
  });

  /**
   * R005 阶段 8（§8.1/§8.3）：application 不得直接调用 localStorage /
   * BroadcastChannel——恢复缓冲与变更广播分别经 RecoveryStore /
   * ChangeChannel port 注入，Web 实现在 platform/web/。
   * 例外：corruptedDiagnostics.ts 为开发诊断记录（非用户数据通道，
   * 未来随诊断存储一并平台化），见该文件头注释。
   */
  it("application 不得直接使用 localStorage/BroadcastChannel（R005 阶段 8）", () => {
    const pattern = /\b(localStorage|BroadcastChannel)\b/;
    const violations: Violation[] = [];
    for (const [path, content] of entries) {
      if (!path.startsWith("../application/")) continue;
      // 开发诊断例外（见规则注释）。
      if (path === "../application/services/corruptedDiagnostics.ts") continue;
      content.split("\n").forEach((text, index) => {
        // 只统计代码行：注释中对 Web 实现的说明不计违规。
        const trimmed = text.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) return;
        if (pattern.test(text)) {
          violations.push({ file: path, line: index + 1, text: trimmed });
        }
      });
    }
    expect(format(violations)).toBe("");
    expect(violations).toEqual([]);
  });

  /**
   * R005 阶段 8B（§8.4）：application 不得直接调用 StorageManager
   * （navigator.storage）——存储用量估算与连接生命周期事件统一经
   * StorageHealthService port 注入，Web 实现在 platform/web/
   * webStorageHealth.ts（原 StorageQuotaService 模块已删除）。
   */
  it("application 不得直接使用 StorageManager（R005 阶段 8B）", () => {
    const pattern = /\b(navigator\s*\.\s*storage|StorageManager)\b/;
    const violations: Violation[] = [];
    for (const [path, content] of entries) {
      if (!path.startsWith("../application/")) continue;
      content.split("\n").forEach((text, index) => {
        // 只统计代码行：注释中对 Web 实现的说明不计违规。
        const trimmed = text.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) return;
        if (pattern.test(text)) {
          violations.push({ file: path, line: index + 1, text: trimmed });
        }
      });
    }
    expect(format(violations)).toBe("");
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

  /**
   * R006 阶段 1：window.e1 / getDesktopApi 只允许出现在 Desktop 装配根
   * （main.desktop.tsx）与 platform/desktop/**——桌面桥是平台边界，
   * 组件与状态层不得直接触碰（测试与测试基建已由 entries 过滤豁免）。
   */
  it("仅 main.desktop.tsx 与 platform/desktop 可访问 window.e1/getDesktopApi（R006 阶段 1）", () => {
    const pattern = /\bwindow\.e1\b|\bgetDesktopApi\b/;
    const violations: Violation[] = [];
    for (const [path, content] of entries) {
      if (path === "../main.desktop.tsx") continue;
      if (path.startsWith("../platform/desktop/")) continue;
      content.split("\n").forEach((text, index) => {
        const trimmed = text.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) return;
        if (pattern.test(text)) {
          violations.push({ file: path, line: index + 1, text: trimmed });
        }
      });
    }
    expect(format(violations)).toBe("");
    expect(violations).toEqual([]);
  });

  /**
   * R006 阶段 1（DUAL-01）：src 不得出现平台名称判断字面量
   * （isElectron / process.platform / process.versions.electron）——
   * 组件只能判断能力矩阵字段。测试与测试基建豁免（entries 已过滤）；
   * 注释中的说明文字不计违规（只统计代码行）。
   */
  it("src 不得出现平台判断字面量 isElectron/process.platform（DUAL-01，R006 阶段 1）", () => {
    const pattern =
      /\bisElectron\b|process\.platform|process\.versions\.electron/;
    const violations: Violation[] = [];
    for (const [path, content] of entries) {
      content.split("\n").forEach((text, index) => {
        const trimmed = text.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) return;
        if (pattern.test(text)) {
          violations.push({ file: path, line: index + 1, text: trimmed });
        }
      });
    }
    expect(format(violations)).toBe("");
    expect(violations).toEqual([]);
  });

  /**
   * R006-C4-H：components/state 不得直呼 note.save / window.e1——写盘只经
   * ContentRepository → DesktopContentRepository → IPC 装配根。
   */
  it("components/state 不得出现 note.save 或 window.e1（R006-C4）", () => {
    const pattern = /\bnote\.save\b|\bwindow\.e1\b/;
    const violations: Violation[] = [];
    for (const [path, content] of entries) {
      if (!path.startsWith("../components/") && !path.startsWith("../state/")) {
        continue;
      }
      content.split("\n").forEach((text, index) => {
        const trimmed = text.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) return;
        if (pattern.test(text)) {
          violations.push({ file: path, line: index + 1, text: trimmed });
        }
      });
    }
    expect(format(violations)).toBe("");
    expect(violations).toEqual([]);
  });

  /**
   * R006-C4.1：Desktop Markdown 写入只经 DesktopMarkdownWriteService；
   * repositories.ts 不得再有第二套 note.save pipeline。
   */
  it("Desktop Content/DocumentWrite 必须依赖 DesktopMarkdownWriteService（R006-C4.1）", () => {
    const repos = sources["../platform/desktop/repositories.ts"] ?? "";
    expect(repos).toContain("DesktopMarkdownWriteService");
    expect(repos).toMatch(/class DesktopContentRepository[\s\S]*this\.writer\.save/);
    expect(repos).toMatch(
      /class DesktopDocumentWriteRepository[\s\S]*this\.writer\.save/,
    );
    expect(repos.match(/\bnote\.save\b/g) ?? []).toEqual([]);
    const runtime = sources["../platform/desktop/createDesktopRuntime.ts"] ?? "";
    expect(runtime).toContain("DesktopMarkdownWriteService");
    expect(runtime).toContain("DesktopIdentityAliasRegistry");
    expect(runtime).toContain("DesktopAssetStore");
    expect(runtime).toContain("DesktopAssetRegistry");
  });

  it("editor 不得出现 pickToken（R006-C5）", () => {
    const violations: Violation[] = [];
    for (const [path, content] of entries) {
      if (!path.startsWith("../editor/")) continue;
      content.split("\n").forEach((text, index) => {
        const trimmed = text.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) return;
        if (/\bpickToken\b/.test(text)) {
          violations.push({ file: path, line: index + 1, text: trimmed });
        }
      });
    }
    expect(format(violations)).toBe("");
    expect(violations).toEqual([]);
  });

  it("application 不得出现绝对路径字段名 absolutePath（R006-C5）", () => {
    const violations: Violation[] = [];
    for (const [path, content] of entries) {
      if (!path.startsWith("../application/")) continue;
      content.split("\n").forEach((text, index) => {
        const trimmed = text.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) return;
        if (/\babsolutePath\b/.test(text)) {
          violations.push({ file: path, line: index + 1, text: trimmed });
        }
      });
    }
    expect(format(violations)).toBe("");
    expect(violations).toEqual([]);
  });
});
