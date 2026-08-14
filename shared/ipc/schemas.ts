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
  AssetPickRequest,
  CreateNoteInput,
  ImportAssetInput,
  ImportAssetSource,
  OpenRecentRequest,
  OpenSelectionRequest,
  PatchNoteMetadataInput,
  PatchVaultStateInput,
  ReadAssetInput,
  ReadNoteInput,
  SaveNoteInput,
  VaultPageStatePatch,
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
 * vault.openSelection（R006-C2.1 FR-01）：selectionToken 必填非空，
 * initialize 必填布尔。令牌有效性（存在/未消费/未过期）由 Main 侧
 * SelectionTokenStore 校验（SELECTION_INVALID / SELECTION_EXPIRED）。
 */
export function parseOpenSelectionRequest(
  payload: unknown,
): OpenSelectionRequest {
  if (!isRecord(payload)) invalid("vault.openSelection 入参必须为对象");
  const initialize = payload.initialize;
  if (typeof initialize !== "boolean") {
    invalid("字段 initialize 必须为布尔值");
  }
  return {
    selectionToken: requireString(payload, "selectionToken", {
      nonEmpty: true,
    }),
    initialize,
  };
}

/**
 * vault.openRecent（R006-C2.1 FR-02）：vaultId 必填非空；
 * 登记/可达性由 Main 侧注册表复查（VAULT_NOT_FOUND）。
 */
export function parseOpenRecentRequest(payload: unknown): OpenRecentRequest {
  if (!isRecord(payload)) invalid("vault.openRecent 入参必须为对象");
  return { vaultId: requireString(payload, "vaultId", { nonEmpty: true }) };
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

/** R007 阶段 1：note.patchMetadata 入参校验（patch 至少携带一个已知键）。 */
export function parsePatchNoteMetadataInput(
  payload: unknown,
): PatchNoteMetadataInput {
  if (!isRecord(payload)) invalid("note.patchMetadata 入参必须为对象");
  const patch = payload.patch;
  if (!isRecord(patch)) invalid("note.patchMetadata.patch 必须为对象");
  const result: PatchNoteMetadataInput["patch"] = {};
  if (patch.title !== undefined) {
    if (typeof patch.title !== "string") {
      invalid("note.patchMetadata.patch.title 必须为字符串");
    }
    result.title = patch.title;
  }
  if (patch.tags !== undefined) {
    if (
      !Array.isArray(patch.tags) ||
      patch.tags.some((item) => typeof item !== "string")
    ) {
      invalid("note.patchMetadata.patch.tags 必须为字符串数组");
    }
    result.tags = patch.tags;
  }
  if (result.title === undefined && result.tags === undefined) {
    invalid("note.patchMetadata.patch 至少包含 title 或 tags 之一");
  }
  return {
    vaultId: requireString(payload, "vaultId", { nonEmpty: true }),
    relativePath: assertRelativePath(
      requireString(payload, "relativePath", { nonEmpty: true }),
    ),
    expectedVersionToken: requireString(payload, "expectedVersionToken"),
    patch: result,
  };
}

/**
 * R007 阶段 2：vaultState.get——payload 即 vaultId 字符串（同 vault.scan）。
 */
export function parseVaultStateGetInput(payload: unknown): string {
  if (typeof payload !== "string" || payload.trim() === "") {
    invalid("vaultState.get 入参必须为非空 vaultId 字符串");
  }
  return payload;
}

/** 毫秒时间戳或 null（清值语义）；拒绝 NaN/负数/非整数。 */
function parseNullableTimestamp(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    invalid(`字段 ${field} 必须为非负整数毫秒时间戳或 null`);
  }
  return value;
}

function parsePageStatePatch(
  value: unknown,
  field: string,
): VaultPageStatePatch {
  if (!isRecord(value)) invalid(`字段 ${field} 必须为对象`);
  const result: VaultPageStatePatch = {};
  if (value.favoriteAt !== undefined) {
    result.favoriteAt = parseNullableTimestamp(
      value.favoriteAt,
      `${field}.favoriteAt`,
    );
  }
  if (value.lastOpenedAt !== undefined) {
    result.lastOpenedAt = parseNullableTimestamp(
      value.lastOpenedAt,
      `${field}.lastOpenedAt`,
    );
  }
  return result;
}

/** R007 阶段 2：vaultState.patch——局部合并，缺省键保持原值。 */
export function parsePatchVaultStateInput(
  payload: unknown,
): PatchVaultStateInput {
  if (!isRecord(payload)) invalid("vaultState.patch 入参必须为对象");
  const patch = payload.patch;
  if (!isRecord(patch)) invalid("vaultState.patch.patch 必须为对象");
  const result: PatchVaultStateInput["patch"] = {};
  if (patch.pages !== undefined) {
    if (!isRecord(patch.pages)) {
      invalid("vaultState.patch.patch.pages 必须为对象");
    }
    const pages: Record<string, VaultPageStatePatch> = {};
    for (const [key, value] of Object.entries(patch.pages)) {
      if (key.trim() === "") {
        invalid("vaultState.patch.patch.pages 的键不能为空");
      }
      pages[key] = parsePageStatePatch(value, `pages["${key}"]`);
    }
    result.pages = pages;
  }
  if (patch.workspace !== undefined) {
    if (!isRecord(patch.workspace)) {
      invalid("vaultState.patch.patch.workspace 必须为对象");
    }
    result.workspace = {};
    if (patch.workspace.favoriteAt !== undefined) {
      result.workspace.favoriteAt = parseNullableTimestamp(
        patch.workspace.favoriteAt,
        "workspace.favoriteAt",
      );
    }
  }
  if (result.pages === undefined && result.workspace === undefined) {
    invalid("vaultState.patch.patch 至少包含 pages 或 workspace 之一");
  }
  return {
    vaultId: requireString(payload, "vaultId", { nonEmpty: true }),
    patch: result,
  };
}

export function parseAssetPickInput(payload: unknown): AssetPickRequest {
  if (payload === undefined || payload === null) return {};
  if (!isRecord(payload)) invalid("asset.pick 入参必须为对象");
  const accept = payload.accept;
  if (accept === undefined) return {};
  if (!Array.isArray(accept) || accept.some((item) => typeof item !== "string")) {
    invalid("asset.pick.accept 必须为字符串数组");
  }
  return { accept };
}

export function parseImportAssetInput(payload: unknown): ImportAssetInput {
  if (!isRecord(payload)) invalid("asset.import 入参必须为对象");
  const vaultId = requireString(payload, "vaultId", { nonEmpty: true });
  const fileName = requireString(payload, "fileName", { nonEmpty: true });
  const mimeType = requireString(payload, "mimeType");
  const source = parseImportAssetSource(payload.source);
  return { vaultId, fileName, mimeType, source };
}

function parseImportAssetSource(value: unknown): ImportAssetSource {
  if (!isRecord(value)) invalid("asset.import.source 必须为对象");
  const kind = value.kind;
  if (kind === "pick-token") {
    const token = value.token;
    if (typeof token !== "string" || token.trim() === "") {
      invalid("asset.import.source.token 必须为非空字符串");
    }
    return { kind: "pick-token", token };
  }
  if (kind === "bytes") {
    const data = value.data;
    if (!(data instanceof Uint8Array)) {
      invalid("asset.import.source.data 必须为 Uint8Array");
    }
    return { kind: "bytes", data };
  }
  invalid("asset.import.source.kind 必须为 pick-token 或 bytes");
}

export function parseReadAssetInput(payload: unknown): ReadAssetInput {
  if (!isRecord(payload)) invalid("asset.read 入参必须为对象");
  return { assetId: requireString(payload, "assetId", { nonEmpty: true }) };
}

/** asset.resolveUrl：payload 即 assetId 字符串。 */
export function parseResolveAssetUrlInput(payload: unknown): string {
  if (typeof payload !== "string" || payload.trim() === "") {
    invalid("asset.resolveUrl 入参必须为非空 assetId 字符串");
  }
  return payload;
}
