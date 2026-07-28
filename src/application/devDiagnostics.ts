/**
 * 开发模式诊断（R003 阶段 8）：仅开发环境输出的性能与损坏指标。
 *
 * 指标：workspace-load / search-query / save-queue / idb-save /
 * db-migration / corrupted-content。
 *
 * 隐私约束（R003 §8.3）：只记录指标名、毫秒数与计数；
 * 绝不记录文档正文、API Key、AI 请求内容——detail 仅允许
 * pageId / 版本号级标识。调用方不得把内容片段传入本模块。
 *
 * 默认仅在 Vite 开发模式且非测试环境启用（生产构建中输出为空操作）；
 * 测试可经 setDevDiagnosticsEnabled 显式打开以断言行为。
 */

/** 默认启用：Vite dev 且不在 vitest 中（测试保持静默）。 */
let enabled = import.meta.env.DEV && !import.meta.env.VITEST;

export function isDevDiagnosticsEnabled(): boolean {
  return enabled;
}

/** 显式开关（测试用）；生产代码不应调用。 */
export function setDevDiagnosticsEnabled(next: boolean): void {
  enabled = next;
}

/** 记录一次耗时指标（毫秒）。 */
export function trackTiming(metric: string, durationMs: number): void {
  if (!enabled) return;
  console.debug(`[dev-diag] ${metric}: ${Math.round(durationMs)}ms`);
}

/** 记录一次计数/事件指标；detail 仅允许标识符（pageId、版本号），禁止内容。 */
export function increment(metric: string, detail?: string): void {
  if (!enabled) return;
  console.debug(`[dev-diag] ${metric}${detail ? `: ${detail}` : ""}`);
}
