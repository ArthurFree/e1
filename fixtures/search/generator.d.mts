// fixtures/search/generator.mjs 的类型声明（perf 测试 import 用）。
export interface GeneratedNote {
  relativePath: string;
  markdown: string;
}

export function generateNote(i: number, random: () => number): GeneratedNote;

export function generateVault(
  targetDir: string,
  count: number,
  seed?: number,
  options?: { links?: boolean },
): Promise<string[]>;
