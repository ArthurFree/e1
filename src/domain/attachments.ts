/**
 * 附件统一校验（R004 阶段 6，§6.2）：单附件最大值、单文档附件总量、
 * 图片 MIME 白名单、文件名长度、Blob 实际大小复核。
 *
 * 校验位于 domain 层，编辑器附件块（attachment.ts）与图片插入
 * （localImage.ts）共用同一入口，不只依赖 <input accept>。
 * 校验失败抛 DomainError，code 供 UI 与测试稳定判断。
 */
import { DomainError } from "./errors";

/** 单附件大小上限：Blob 整体存 IndexedDB，超限直接拒绝。 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** 单文档附件总量上限：防止单文档附件无上限累积撑爆本地存储。 */
export const MAX_DOCUMENT_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** 附件文件名长度上限（字符）。 */
export const MAX_ATTACHMENT_NAME_LENGTH = 200;

/**
 * 图片 MIME 白名单：仅常见位图与 SVG。
 * SVG 经 <img> 渲染不执行脚本，可安全保留；其余 image/* 子类型拒绝。
 */
export const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

/** 附件校验入参；blob 为实际二进制（大小以 blob.size 为准，不信任声明值）。 */
export interface ValidateAttachmentInput {
  name: string;
  mimeType: string;
  blob: Blob;
  /** 所属文档已有附件总字节数（调用方经 listByPage 求和）。 */
  existingTotalBytes: number;
  /** true 时按图片 MIME 白名单校验（图片插入路径）。 */
  requireImage?: boolean;
}

/**
 * 校验附件可写入；不合法时抛 DomainError：
 * - 文件名超长 → INVALID_INPUT；
 * - 图片 MIME 不在白名单 → UNSUPPORTED_ATTACHMENT_TYPE；
 * - 单文件超限或总量超限 → ATTACHMENT_TOO_LARGE。
 */
export function validateAttachment(input: ValidateAttachmentInput): void {
  const name = input.name.trim();
  if (name.length === 0 || name.length > MAX_ATTACHMENT_NAME_LENGTH) {
    throw new DomainError(
      "INVALID_INPUT",
      `附件文件名长度须在 1～${MAX_ATTACHMENT_NAME_LENGTH} 字符之间`,
    );
  }
  if (input.requireImage && !IMAGE_MIME_TYPES.has(input.mimeType)) {
    throw new DomainError(
      "UNSUPPORTED_ATTACHMENT_TYPE",
      `不支持的图片类型: ${input.mimeType || "未知"}，仅支持 PNG/JPEG/GIF/WebP/SVG`,
    );
  }
  // Blob 实际大小复核：以 blob.size 为准，防止声明 size 与实际不符。
  const actualBytes = input.blob.size;
  if (actualBytes > MAX_ATTACHMENT_BYTES) {
    throw new DomainError(
      "ATTACHMENT_TOO_LARGE",
      `附件「${input.name}」超过 ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB 上限`,
    );
  }
  if (input.existingTotalBytes + actualBytes > MAX_DOCUMENT_ATTACHMENT_BYTES) {
    throw new DomainError(
      "ATTACHMENT_TOO_LARGE",
      `本文档附件总量超过 ${Math.floor(MAX_DOCUMENT_ATTACHMENT_BYTES / 1024 / 1024)}MB 上限，请先清理不需要的附件`,
    );
  }
}
