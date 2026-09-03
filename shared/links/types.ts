/**
 * R010 §15 数据模型：文档链接与反向链接。
 *
 * 环境中立、零依赖：shared/ipc 契约、Renderer、Electron Main 共用。
 * targetPageId 使用 stable page id（LINK-02：运行时身份），
 * targetRelativePath 使用 vault 根 posix 相对路径（LINK-02：磁盘身份），
 * 两者明确分离；broken 由索引层在解析目标存在性时落库（非独立状态机）。
 */
import type { LinkKind } from "./linkKind.js";

export type { LinkKind };

/** 文档中的一条出站链接。 */
export interface DocumentLink {
  sourcePageId: string;

  /** 原始 href（磁盘原文）。 */
  href: string;
  /** 链接显示文本。 */
  label: string;

  kind: LinkKind;

  /** 解析成功时为 stable page id，未解析（含 broken）为 null。 */
  targetPageId: string | null;
  /** 归一到 vault 根的 posix 相对路径；非 internal 或解析失败为 null。 */
  targetRelativePath: string | null;
  /** `#anchor` 片段（不含 `#`），无则 null。 */
  fragment: string | null;

  /** 目标不可解析（文件不存在/路径逃逸）时为 true。 */
  broken: boolean;
  /** 来源文档的版本令牌（写入时快照，用于增量去重）。 */
  sourceVersion: string;
}

/** 一条反向链接：谁引用了当前页面。 */
export interface Backlink {
  sourcePageId: string;
  targetPageId: string;

  sourceTitle: string;
  /** 链接所在行的上下文摘录，无则 null。 */
  snippet: string | null;
  href: string;
}
