import { describe, expect, it } from "vitest";
import { isDomainError } from "./errors";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_NAME_LENGTH,
  MAX_DOCUMENT_ATTACHMENT_BYTES,
  validateAttachment,
} from "./attachments";

function blobOf(bytes: number): Blob {
  return new Blob([new Uint8Array(bytes)]);
}

function baseInput(
  overrides: Partial<Parameters<typeof validateAttachment>[0]>,
) {
  return {
    name: "文件.png",
    mimeType: "image/png",
    blob: blobOf(1024),
    existingTotalBytes: 0,
    ...overrides,
  };
}

describe("validateAttachment（R004 阶段 6 统一校验）", () => {
  it("合法附件通过", () => {
    expect(() => validateAttachment(baseInput({}))).not.toThrow();
    expect(() =>
      validateAttachment(baseInput({ requireImage: true })),
    ).not.toThrow();
  });

  it("文件名超长 → INVALID_INPUT", () => {
    const name = "长".repeat(MAX_ATTACHMENT_NAME_LENGTH + 1);
    try {
      validateAttachment(baseInput({ name }));
      expect.unreachable();
    } catch (err) {
      expect(isDomainError(err, "INVALID_INPUT")).toBe(true);
    }
  });

  it("空文件名 → INVALID_INPUT", () => {
    try {
      validateAttachment(baseInput({ name: "   " }));
      expect.unreachable();
    } catch (err) {
      expect(isDomainError(err, "INVALID_INPUT")).toBe(true);
    }
  });

  it("图片 MIME 不在白名单 → UNSUPPORTED_ATTACHMENT_TYPE", () => {
    for (const mimeType of ["image/tiff", "image/bmp", "application/pdf"]) {
      try {
        validateAttachment(baseInput({ mimeType, requireImage: true }));
        expect.unreachable(`应拒绝 ${mimeType}`);
      } catch (err) {
        expect(isDomainError(err, "UNSUPPORTED_ATTACHMENT_TYPE")).toBe(true);
      }
    }
  });

  it("白名单内的图片 MIME 全部通过", () => {
    for (const mimeType of [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/svg+xml",
    ]) {
      expect(() =>
        validateAttachment(baseInput({ mimeType, requireImage: true })),
      ).not.toThrow();
    }
  });

  it("非图片路径不做 MIME 白名单限制", () => {
    expect(() =>
      validateAttachment(baseInput({ mimeType: "application/pdf" })),
    ).not.toThrow();
  });

  it("单文件超限（以 Blob 实际大小为准）→ ATTACHMENT_TOO_LARGE", () => {
    try {
      validateAttachment(baseInput({ blob: blobOf(MAX_ATTACHMENT_BYTES + 1) }));
      expect.unreachable();
    } catch (err) {
      expect(isDomainError(err, "ATTACHMENT_TOO_LARGE")).toBe(true);
    }
  });

  it("单文档附件总量超限 → ATTACHMENT_TOO_LARGE", () => {
    try {
      validateAttachment(
        baseInput({
          blob: blobOf(1024),
          existingTotalBytes: MAX_DOCUMENT_ATTACHMENT_BYTES,
        }),
      );
      expect.unreachable();
    } catch (err) {
      expect(isDomainError(err, "ATTACHMENT_TOO_LARGE")).toBe(true);
    }
  });

  it("总量恰好到上限可通过", () => {
    expect(() =>
      validateAttachment(
        baseInput({
          blob: blobOf(1024),
          existingTotalBytes: MAX_DOCUMENT_ATTACHMENT_BYTES - 1024,
        }),
      ),
    ).not.toThrow();
  });
});
