/**
 * Frontmatter 解析与生成（R005 阶段 4，批次 4A）。
 *
 * R006 阶段 2：实现已平移至 shared/markdown/frontmatter.ts（Electron Main
 * 扫描 Vault 需与 MarkdownCodec 完全一致的解析行为，electron 不得 import
 * src；shared 双向可用），本文件仅作 re-export 保持既有 import 路径不变。
 * 语义注释（最小 YAML 子集、未知字段 rawLines 保留策略等）见 shared 侧文件头。
 */
export {
  generateFrontmatter,
  splitFrontmatter,
} from "../../../shared/markdown/frontmatter";
export type { FrontmatterSplit } from "../../../shared/markdown/frontmatter";
