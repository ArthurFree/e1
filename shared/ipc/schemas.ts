/**
 * R006 阶段 1：IPC 请求的运行时校验器（零依赖手写，不引 zod）。
 *
 * Main 不信任 Renderer 入参：每个 handler 先经本模块逐字段校验形状/类型，
 * 失败抛 IpcFailure（INVALID_INPUT；路径逃逸类抛 PATH_ESCAPE）。
 *
 * 路径检查说明（r006 §17）：此处只做契约层的静态拒绝——绝对路径、
 * 盘符注入、".." 段、空段；完整的 normalize → realpath → Vault 根内判定
 * 属阶段 2 的 PathGuard（需访问真实文件系统，不在 shared 层）。
 */
import { IpcFailure } from "../errors.js";
import type {
  CreateNoteInput,
  ImportAssetInput,
  OpenVaultRequest,
  ReadNoteInput,
  SaveNoteInput,
} from "./contracts.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new IpcFailure("INVALID_INPUT", message);
}

/** 读取必填字符串字段；nonEmpty 时拒绝空串/纯空白。 */
function requireString(
  record: Record<string, unknown>,
  field: string,
  options: { nonEmpty?: boolean } = {},
): string {
  const value = record[field];
  if (typeof value !== "string") {
    invalid(`字段 ${field} 必须为字符串`);
  }
  if (options.nonEmpty && value.trim() === "") {
    invalid(`字段 ${field} 不能为空`);
  }
  return value;
}

/**
 * 校验相对 Vault 根的 POSIX 风格路径：拒绝绝对路径、Windows 盘符注入、
 * ".." 逃逸段与空段。通过者原样返回。
 */
export function assertRelativePath(
  value: string,
  field = "relativePath",
): string {
  if (value.trim() === "") invalid(`字段 ${field} 不能为空`);
  if (value.startsWith("/") || value.startsWith("\\")) {
    throw new IpcFailure("PATH_ESCAPE", `字段 ${field} 不允许绝对路径`);
  }
  if (/^[a-zA-Z]:[\\/]/.test(value)) {
    throw new IpcFailure("PATH_ESCAPE", `字段 ${field} 不允许盘符绝对路径`);
  }
  const segments = value.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new IpcFailure("PATH_ESCAPE", `字段 ${field} 含非法路径段`);
  }
  return value;
}

/** 无入参 handler 的占位校验：payload 必须为 undefined/null。 */
export function parseNoInput(payload: unknown): void {
  if (payload !== undefined && payload !== null) {
    invalid("该接口不接受入参");
  }
}

/** vault.scan：payload 即 vaultId 字符串。 */
export function parseVaultScanRequest(payload: unknown): string {
  if (typeof payload !== "string" || payload.trim() === "") {
    invalid("vault.scan 入参必须为非空 vaultId 字符串");
  }
  return payload;
}

/**
 * vault.open：absolutePath 必填非空；name 可选字符串（仅初始化时生效）。
 * 绝对性/存在性由 Main 侧 vault.open 实现复查（schema 层只校验形状）。
 */
export function parseOpenVaultRequest(payload: unknown): OpenVaultRequest {
  if (!isRecord(payload)) invalid("vault.open 入参必须为对象");
  const request: OpenVaultRequest = {
    absolutePath: requireString(payload, "absolutePath", { nonEmpty: true }),
  };
  if (payload.name !== undefined) {
    request.name = requireString(payload, "name", { nonEmpty: true });
  }
  return request;
}

export function parseReadNoteInput(payload: unknown): ReadNoteInput {
  if (!isRecord(payload)) invalid("note.read 入参必须为对象");
  return {
    vaultId: requireString(payload, "vaultId", { nonEmpty: true }),
    relativePath: assertRelativePath(
      requireString(payload, "relativePath", { nonEmpty: true }),
    ),
  };
}

export function parseCreateNoteInput(payload: unknown): CreateNoteInput {
  if (!isRecord(payload)) invalid("note.create 入参必须为对象");
  const input: CreateNoteInput = {
    vaultId: requireString(payload, "vaultId", { nonEmpty: true }),
    // 目标目录允许空串（根目录）；非空时按相对路径校验。
    directory: (() => {
      const dir = requireString(payload, "directory");
      return dir === "" ? dir : assertRelativePath(dir, "directory");
    })(),
    title: requireString(payload, "title"),
  };
  if (payload.markdown !== undefined) {
    if (typeof payload.markdown !== "string") {
      invalid("字段 markdown 必须为字符串");
    }
    input.markdown = payload.markdown;
  }
  return input;
}

export function parseSaveNoteInput(payload: unknown): SaveNoteInput {
  if (!isRecord(payload)) invalid("note.save 入参必须为对象");
  return {
    vaultId: requireString(payload, "vaultId", { nonEmpty: true }),
    relativePath: assertRelativePath(
      requireString(payload, "relativePath", { nonEmpty: true }),
    ),
    markdown: requireString(payload, "markdown"),
    // 版本令牌不透明，此处只校验类型；初始令牌为空串（尚无正文版本）。
    expectedVersionToken: requireString(payload, "expectedVersionToken"),
  };
}

export function parseImportAssetInput(payload: unknown): ImportAssetInput {
  if (!isRecord(payload)) invalid("asset.import 入参必须为对象");
  return {
    vaultId: requireString(payload, "vaultId", { nonEmpty: true }),
    // 源文件绝对路径只可能来自 asset.pick 的 Main 侧返回值；
    // Main 实现仍需复查其存在性与类型白名单（阶段 5）。
    sourceAbsolutePath: requireString(payload, "sourceAbsolutePath", {
      nonEmpty: true,
    }),
    fileName: requireString(payload, "fileName", { nonEmpty: true }),
  };
}

/** asset.resolveUrl：payload 即 assetId 字符串。 */
export function parseResolveAssetUrlInput(payload: unknown): string {
  if (typeof payload !== "string" || payload.trim() === "") {
    invalid("asset.resolveUrl 入参必须为非空 assetId 字符串");
  }
  return payload;
}
