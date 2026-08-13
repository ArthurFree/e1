/**
 * R006-C5 FR-08/09：资源文件名清理与同名递增。
 * 口径对齐 markdownFileName.ts，但保留原扩展名。
 */
import { assertSafeFileName } from "./PathGuard.js";

const ILLEGAL_CHARS = /[\\/:*?"<>|]/g;
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function stripControlChars(value: string): string {
  let out = "";
  for (const ch of value) {
    if (ch.charCodeAt(0) >= 0x20) out += ch;
  }
  return out;
}

function splitName(fileName: string): { stem: string; ext: string } {
  const base = fileName.split(/[/\\]/).pop() ?? fileName;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return { stem: base, ext: "" };
  return { stem: base.slice(0, dot), ext: base.slice(dot) };
}

function sanitizeStem(stem: string): string {
  let out = stripControlChars(stem).replace(ILLEGAL_CHARS, "-");
  out = out.replace(/\s+/g, " ").trim();
  while (out.endsWith(".") || out.endsWith(" ")) {
    out = out.replace(/[.\s]+$/, "");
  }
  if (out === "") out = "file";
  if (RESERVED_NAME.test(out)) out = `${out}_`;
  while (Buffer.byteLength(out, "utf8") > 180) {
    out = out.slice(0, -1);
  }
  while (out.endsWith(".") || out.endsWith(" ")) {
    out = out.replace(/[.\s]+$/, "");
  }
  if (out === "") out = "file";
  return out;
}

function sanitizeExt(ext: string): string {
  if (!ext) return "";
  let out = stripControlChars(ext).replace(ILLEGAL_CHARS, "");
  out = out.replace(/\s+/g, "");
  while (out.endsWith(".") || out.endsWith(" ")) {
    out = out.replace(/[.\s]+$/, "");
  }
  if (!out.startsWith(".")) out = `.${out}`;
  if (out === ".") return "";
  return out.toLowerCase();
}

/** 原文件名 → 安全 stem + 扩展名（扩展名保留并小写）。 */
export function sanitizeAssetFileParts(fileName: string): {
  stem: string;
  ext: string;
} {
  const { stem, ext } = splitName(fileName);
  return { stem: sanitizeStem(stem), ext: sanitizeExt(ext) };
}

/**
 * 冲突序号对应的文件名：0 → image.png；1 → image (2).png；2 → image (3).png。
 */
export function assetFileNameForAttempt(
  stem: string,
  ext: string,
  attempt: number,
): string {
  const name =
    attempt === 0 ? `${stem}${ext}` : `${stem} (${attempt + 1})${ext}`;
  assertSafeFileName(name);
  return name;
}

export function inferMimeFromFileName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "pdf":
      return "application/pdf";
    case "txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}
