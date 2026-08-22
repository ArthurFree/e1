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
  CreateDirectoryInput,
  CreateNoteInput,
  ImportAssetInput,
  ImportAssetSource,
  ListTrashInput,
  MoveNoteInput,
  OpenRecentRequest,
  OpenSelectionRequest,
  PatchNoteMetadataInput,
  PatchVaultStateInput,
  PurgeTrashInput,
  ReadAssetInput,
  ReadNoteInput,
  RenameNoteFileInput,
  RestoreTrashInput,
  RevealAssetInput,
  RevealNoteInput,
  SaveNoteInput,
  SearchQueryInput,
  SearchRebuildInput,
  SearchRelocateInput,
  SearchUpsertInput,
  SecretSetInput,
  TrashInput,
  VaultFsEvent,
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

/** 目录路径字段：允许空串（Vault 根），非空按相对路径校验。 */
function parseDirectoryPath(
  record: Record<string, unknown>,
  field: string,
): string {
  const dir = requireString(record, field);
  return dir === "" ? dir : assertRelativePath(dir, field);
}

/**
 * 单段名称的静态校验（文件/目录名共用）：拒绝空、路径分隔符与
 * "." / ".." 段；非法字符/保留设备名/长度等完整校验由 Main 侧
 * PathGuard.assertSafeFileName 复查（需与文件系统口径一致，不在 shared 层）。
 */
function assertSingleSegmentName(value: string, field: string): string {
  if (value.trim() === "") invalid(`字段 ${field} 不能为空`);
  if (value === "." || value === ".." || /[\\/]/.test(value)) {
    invalid(`字段 ${field} 必须为单段名称（不含路径分隔符）`);
  }
  return value;
}

/** R007 阶段 4（§4.1）：vault.createDirectory 入参校验。 */
export function parseCreateDirectoryInput(
  payload: unknown,
): CreateDirectoryInput {
  if (!isRecord(payload)) invalid("vault.createDirectory 入参必须为对象");
  return {
    vaultId: requireString(payload, "vaultId", { nonEmpty: true }),
    parentRelativePath: parseDirectoryPath(payload, "parentRelativePath"),
    name: assertSingleSegmentName(
      requireString(payload, "name", { nonEmpty: true }),
      "name",
    ),
  };
}

/** R007 阶段 4（§4.2）：vault.trash 入参校验（文件/目录同形）。 */
export function parseTrashInput(payload: unknown): TrashInput {
  if (!isRecord(payload)) invalid("vault.trash 入参必须为对象");
  return {
    vaultId: requireString(payload, "vaultId", { nonEmpty: true }),
    relativePath: assertRelativePath(
      requireString(payload, "relativePath", { nonEmpty: true }),
    ),
  };
}

/** R007 阶段 4：vault.listTrash 入参校验。 */
export function parseListTrashInput(payload: unknown): ListTrashInput {
  if (!isRecord(payload)) invalid("vault.listTrash 入参必须为对象");
  return { vaultId: requireString(payload, "vaultId", { nonEmpty: true }) };
}

/** R007 阶段 4：vault.restore 入参校验。 */
export function parseRestoreTrashInput(payload: unknown): RestoreTrashInput {
  if (!isRecord(payload)) invalid("vault.restore 入参必须为对象");
  return {
    vaultId: requireString(payload, "vaultId", { nonEmpty: true }),
    operationId: requireString(payload, "operationId", { nonEmpty: true }),
  };
}

/** R007 阶段 4：vault.purgeTrash 入参校验（operationId 缺省 = 清空全部）。 */
export function parsePurgeTrashInput(payload: unknown): PurgeTrashInput {
  if (!isRecord(payload)) invalid("vault.purgeTrash 入参必须为对象");
  const input: PurgeTrashInput = {
    vaultId: requireString(payload, "vaultId", { nonEmpty: true }),
  };
  if (payload.operationId !== undefined) {
    if (
      typeof payload.operationId !== "string" ||
      payload.operationId.trim() === ""
    ) {
      invalid("字段 operationId 必须为非空字符串");
    }
    input.operationId = payload.operationId;
  }
  return input;
}

/** R007 阶段 4（§4.3）：note.move 入参校验。 */
export function parseMoveNoteInput(payload: unknown): MoveNoteInput {
  if (!isRecord(payload)) invalid("note.move 入参必须为对象");
  return {
    vaultId: requireString(payload, "vaultId", { nonEmpty: true }),
    relativePath: assertRelativePath(
      requireString(payload, "relativePath", { nonEmpty: true }),
    ),
    targetDirectory: parseDirectoryPath(payload, "targetDirectory"),
  };
}

/** R007 阶段 4（§4.4）：note.renameFile 入参校验（newName 单段且 .md 结尾）。 */
export function parseRenameNoteFileInput(
  payload: unknown,
): RenameNoteFileInput {
  if (!isRecord(payload)) invalid("note.renameFile 入参必须为对象");
  const newName = assertSingleSegmentName(
    requireString(payload, "newName", { nonEmpty: true }),
    "newName",
  );
  if (!/\.md$/i.test(newName)) {
    invalid("字段 newName 必须以 .md 结尾（只支持重命名 Markdown 文件）");
  }
  return {
    vaultId: requireString(payload, "vaultId", { nonEmpty: true }),
    relativePath: assertRelativePath(
      requireString(payload, "relativePath", { nonEmpty: true }),
    ),
    newName,
  };
}

export function parseAssetPickInput(payload: unknown): AssetPickRequest {
  if (payload === undefined || payload === null) return {};
  if (!isRecord(payload)) invalid("asset.pick 入参必须为对象");
  const accept = payload.accept;
  if (accept === undefined) return {};
  if (
    !Array.isArray(accept) ||
    accept.some((item) => typeof item !== "string")
  ) {
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

/* ---------------------------------- 阶段 5 ---------------------------------- */

/** R007 阶段 5：note.reveal 入参校验（与 note.read 同形；目录同样允许）。 */
export function parseRevealNoteInput(payload: unknown): RevealNoteInput {
  if (!isRecord(payload)) invalid("note.reveal 入参必须为对象");
  return {
    vaultId: requireString(payload, "vaultId", { nonEmpty: true }),
    relativePath: assertRelativePath(
      requireString(payload, "relativePath", { nonEmpty: true }),
    ),
  };
}

/** R007 阶段 5：asset.reveal 入参校验（与 asset.read 同形）。 */
export function parseRevealAssetInput(payload: unknown): RevealAssetInput {
  if (!isRecord(payload)) invalid("asset.reveal 入参必须为对象");
  return { assetId: requireString(payload, "assetId", { nonEmpty: true }) };
}

/**
 * R007 阶段 5：secret 名（"<域>.<键>"）——小写字母开头的域名 + 点 +
 * 键名段（字母/数字/连字符，键段大小写均可，如 "ai.apiKey"）；上限
 * 128 字符。白名单形态防止把任意字符串当作存储键
 *（userData/secrets.json 的 JSON 键）。
 */
const SECRET_NAME = /^[a-z][a-z0-9-]*(\.[A-Za-z0-9-]+)+$/;
const MAX_SECRET_NAME_LENGTH = 128;
/** secret 值上限（字符）：API Key 远小于此；防异常大 payload 拖垮加密/落盘。 */
const MAX_SECRET_VALUE_LENGTH = 16_384;

function parseSecretName(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    invalid(`字段 ${field} 必须为非空字符串`);
  }
  if (value.length > MAX_SECRET_NAME_LENGTH || !SECRET_NAME.test(value)) {
    invalid(`字段 ${field} 不是合法的 secret 名（"<域>.<键>"）`);
  }
  return value;
}

/** secret.get / secret.delete：payload 即 secret 名字符串。 */
export function parseSecretNameRequest(payload: unknown): string {
  return parseSecretName(payload, "name");
}

/** R007 阶段 5：secret.set 入参校验。 */
export function parseSecretSetInput(payload: unknown): SecretSetInput {
  if (!isRecord(payload)) invalid("secret.set 入参必须为对象");
  const name = parseSecretName(payload.name, "name");
  const value = payload.value;
  if (typeof value !== "string") invalid("字段 value 必须为字符串");
  if (value === "") invalid("字段 value 不能为空（清空请用 secret.delete）");
  if (value.length > MAX_SECRET_VALUE_LENGTH) {
    invalid("字段 value 超出长度上限（16 KiB）");
  }
  return { name, value };
}

/* ------------------------------- 阶段 4：search ------------------------------- */

/** search.query 入参校验（R008 Stage 4 §10.6：query 必填字符串，limit 上限 100）。 */
export function parseSearchQueryInput(payload: unknown): SearchQueryInput {
  if (!isRecord(payload)) invalid("search.query 入参必须为对象");
  const query = requireString(payload, "query");
  if (query.length > 500) invalid("字段 query 超出长度上限（500 字符）");
  const vaultId = payload.vaultId;
  if (vaultId !== undefined && typeof vaultId !== "string") {
    invalid("字段 vaultId 必须为字符串");
  }
  const limit = payload.limit;
  if (
    limit !== undefined &&
    (typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100)
  ) {
    invalid("字段 limit 必须为 1–100 的整数");
  }
  return {
    ...(vaultId !== undefined ? { vaultId } : {}),
    query,
    ...(limit !== undefined ? { limit } : {}),
  };
}

/** search.rebuild / search.status 入参校验（vaultId 必填）。 */
export function parseSearchVaultInput(payload: unknown): SearchRebuildInput {
  if (!isRecord(payload)) invalid("search 入参必须为对象");
  return { vaultId: requireString(payload, "vaultId", { nonEmpty: true }) };
}

/** search.upsert / search.remove 入参校验（vaultId + relativePath）。 */
export function parseSearchUpsertInput(payload: unknown): SearchUpsertInput {
  if (!isRecord(payload)) invalid("search.upsert/remove 入参必须为对象");
  return {
    vaultId: requireString(payload, "vaultId", { nonEmpty: true }),
    relativePath: assertRelativePath(
      requireString(payload, "relativePath", { nonEmpty: true }),
    ),
  };
}

/** search.relocate 入参校验（from/to 双路径）。 */
export function parseSearchRelocateInput(
  payload: unknown,
): SearchRelocateInput {
  if (!isRecord(payload)) invalid("search.relocate 入参必须为对象");
  return {
    vaultId: requireString(payload, "vaultId", { nonEmpty: true }),
    from: assertRelativePath(
      requireString(payload, "from", { nonEmpty: true }),
      "from",
    ),
    to: assertRelativePath(
      requireString(payload, "to", { nonEmpty: true }),
      "to",
    ),
  };
}

/**
 * R007 阶段 3：events:vaultChanges 推送 payload 校验（Preload 侧）。
 *
 * 与请求校验方向相反——这里校验的是 Main 推送的事件批次，Preload 在
 * 投递给 Renderer 回调前调用；形状非法抛 IpcFailure 由订阅方决定丢弃。
 */
const VAULT_FS_EVENT_TYPES = new Set([
  "note-created",
  "note-changed",
  "note-removed",
  "asset-changed",
  "rescan-required",
]);

export function parseVaultFsEvents(payload: unknown): VaultFsEvent[] {
  if (!Array.isArray(payload)) {
    invalid("events:vaultChanges payload 必须为事件数组");
  }
  return payload.map((item, index): VaultFsEvent => {
    if (!isRecord(item)) invalid(`事件[${index}] 必须为对象`);
    const type = item.type;
    if (typeof type !== "string" || !VAULT_FS_EVENT_TYPES.has(type)) {
      invalid(`事件[${index}].type 非法`);
    }
    const vaultId = requireString(item, "vaultId", { nonEmpty: true });
    if (type === "rescan-required") {
      return { type, vaultId };
    }
    const relativePath = requireString(item, "relativePath", {
      nonEmpty: true,
    });
    return { type, vaultId, relativePath } as VaultFsEvent;
  });
}
