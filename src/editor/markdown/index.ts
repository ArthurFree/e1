/**
 * 持久化级 MarkdownCodec（R005 阶段 4，批次 4A）公开入口。
 * 与 src/editor/markdown.ts（导入导出工具）并存，调用方切换属批次 4B。
 */
export { createMarkdownCodec } from "./codec";
export { generateFrontmatter, splitFrontmatter } from "./frontmatter";
export type { FrontmatterSplit } from "./frontmatter";
export { resolveRelativePath } from "./links";
export type {
  FrontmatterExtraField,
  MarkdownAssetResolver,
  MarkdownCodec,
  MarkdownSerializationResult,
  ParsedAssetReference,
  ParsedLink,
  ParsedNote,
  PortableNoteMetadata,
  UnsupportedMarkdownFeature,
} from "./types";
