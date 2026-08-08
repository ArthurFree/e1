/**
 * 持久化级 MarkdownCodec 类型定义（R005 阶段 4，批次 4A）。
 *
 * 背景：src/editor/markdown.ts 的 markdownToJson/jsonToMarkdown 只是
 * 「导入导出工具」，不处理 Frontmatter、稳定 ID、相对链接、附件路径与
 * 有损回写检测（r005.md §一.3.3）。本模块定义 Web 与 Desktop 共用的
 * 文件格式核心接口（r005.md §九），字段语义以 r005.md 与
 * docs/architecture/portable-vault.md（identityMode: frontmatter）为准。
 *
 * 节点级序列化策略对照表：docs/architecture/markdown-compatibility.md。
 */

/** Frontmatter 中无法识别（未纳入已知字段集）的字段，原始行保序保留。 */
export interface FrontmatterExtraField {
  /** 字段名（YAML key），仅诊断用途；写回以 rawLines 为准。 */
  key: string;
  /**
   * 该字段在原文中的完整行（含 `key: value` 行与续行，如块式列表项），
   * serialize 时逐行原样写回——不解析、不重排、不丢弃。
   */
  rawLines: string[];
}

/**
 * 笔记的可移植元数据：Portable Vault Frontmatter 的内存形态
 * （portable-vault.md：id/title/tags/created/updated，aliases 为通用扩展）。
 * 时间字段为 ISO 字符串。
 */
export interface PortableNoteMetadata {
  id?: string;
  title?: string;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  aliases?: string[];
  /** 解析侧保留的未知 Frontmatter 字段；serialize 原样写回。 */
  extra?: FrontmatterExtraField[];
}

/** 解析出的笔记内链接（只收集不改写；链接重写属 Portable Vault 阶段）。 */
export interface ParsedLink {
  /** markdown：标准 `[文本](target)`；wiki：`[[页面]]` / `[[页面#段落]]`。 */
  type: "markdown" | "wiki";
  /** 原始目标：markdown 链接的 href 原文 / wiki 链接的页面名。 */
  target: string;
  /** 显示文本：markdown 链接文本 / wiki 别名（`[[页面|别名]]`）。 */
  text?: string;
  /** wiki 链接的段落锚点（`[[页面#段落]]` 的「段落」部分，与 target 分离）。 */
  anchor?: string;
  /**
   * 相对 vault 根解析后的路径：仅当 parse 提供 relativePath 且 target
   * 为相对路径时给出；外部 URL / 绝对路径 / 纯锚点不解析（undefined）。
   */
  resolvedPath?: string;
}

/** 解析出的资源引用（图片 / 附件文件链接）。二进制写回属批次 4B。 */
export interface ParsedAssetReference {
  /** image：`![alt](路径)`；attachment：指向非 .md 文件的相对链接。 */
  type: "image" | "attachment";
  /** Markdown 中的原始引用路径。 */
  target: string;
  /** 图片 alt / 附件链接文本。 */
  name?: string;
  /** 相对 vault 根解析后的路径（规则同 ParsedLink.resolvedPath）。 */
  resolvedPath?: string;
}

/** 无法安全转换的语法/节点记录：kind 稳定，snippet 为原文片段。 */
export interface UnsupportedMarkdownFeature {
  /**
   * 稳定类别标识，如 "raw-html" / "wiki-link" / "footnote" /
   * "image-data-uri" / "mention" / "local-image" / "attachment" /
   * "text-style" / "subscript" / "superscript" / "text-align" / "indent" /
   * "table-cell-content" / "local-image-width"。
   */
  kind: string;
  /** 原文片段或节点摘要（截断），供导入报告展示。 */
  snippet?: string;
  /** 中文说明：发生了什么、内容以何种形式保留。 */
  message: string;
}

/** parse 结果（r005.md §九 ParsedNote；metadata.extra 为未知字段保留扩展）。 */
export interface ParsedNote {
  /** 经编辑器白名单 schema 解析并复核的文档 JSON。 */
  document: unknown;
  metadata: {
    id?: string;
    title?: string;
    tags: string[];
    createdAt?: string;
    updatedAt?: string;
    aliases: string[];
    /** 未知 Frontmatter 字段（保序），serialize 时原样写回。 */
    extra: FrontmatterExtraField[];
  };
  links: ParsedLink[];
  assets: ParsedAssetReference[];
  unsupported: UnsupportedMarkdownFeature[];
  /** 输入文件的换行符风格（serialize 默认输出 LF，可选跟随）。 */
  lineEnding: "lf" | "crlf";
}

/**
 * 资源路径解析器（portable-vault.md：路径经统一入口生成，文件名冲突走
 * 确定性规则）。本批仅定义接口并用于生成 Markdown 引用路径；
 * 二进制写入 assets/ 与 Web 导出集成属批次 4B。
 */
export interface MarkdownAssetResolver {
  resolveAssetPath(input: {
    attachmentId: string;
    /** 建议文件名（附件名 / 图片 alt）；冲突重命名由实现方负责。 */
    name: string;
    kind: "image" | "attachment";
  }): string;
}

/** serialize 结果：lossy 标记发生了有损转换，unsupported 逐条说明。 */
export interface MarkdownSerializationResult {
  markdown: string;
  /** true 表示有节点/样式无法安全转为 Markdown（已降级为可见文本，未静默删除）。 */
  lossy: boolean;
  unsupported: UnsupportedMarkdownFeature[];
}

/**
 * 持久化级 MarkdownCodec（r005.md §九接口；serialize 入参在规格基础上
 * 增加两个可选字段：lineEnding 与 resolveMentionPath，见下）。
 */
export interface MarkdownCodec {
  parse(input: {
    markdown: string;
    /** 笔记在 vault 内的相对路径（如 notes/工作/项目 A.md），用于解析相对链接。 */
    relativePath?: string;
  }): Promise<ParsedNote>;

  serialize(input: {
    document: unknown;
    metadata: PortableNoteMetadata;
    assetResolver: MarkdownAssetResolver;
    /**
     * portable：Portable Vault 迁移格式（Frontmatter + 相对资源路径）；
     * plain：纯正文导出，资源/提及等降级为可见文本并计入 unsupported。
     */
    mode: "portable" | "plain";
    /**
     * 输出换行符，默认 "lf"（规格默认）；传 "crlf" 可跟随 parse 的
     * lineEnding 检测结果，实现「从哪来回哪去」。
     */
    lineEnding?: "lf" | "crlf";
    /**
     * 可选：@ 提及目标页 → vault 内相对路径。提供且命中时 mention 序列化为
     * 标准相对 Markdown 链接；缺省或返回 null 时按
     * markdown-compatibility.md 矩阵降级为纯文本 `@标题` 并计入 unsupported。
     */
    resolveMentionPath?: (pageId: string) => string | null;
  }): Promise<MarkdownSerializationResult>;
}
