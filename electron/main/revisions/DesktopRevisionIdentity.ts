/**
 * R012 Stage 1（需求 §17、§24）：revision series 身份解析与路径元数据维护。
 *
 * 身份规则：
 * - 有 stable id（Frontmatter id）的文档：seriesId 由 stableNoteId 确定性
 *   派生（`sn_<stableNoteId>`），rename/move 后历史不变；
 * - path-only 文档：随机 seriesId（`sp_<ulid>`），series.json 记录当前路径，
 *   resolveSeries 按 currentRelativePath 匹配已有孤儿 series；
 * - 外部程序移动且无 stable id 时**不猜测身份**：找不到就新建（v1 边界，
 *   adoption/portability 增强属 R014 方向）。
 *
 * relocate / relocatePrefix（R011 文件操作 reconcile，接线在后续 Stage）：
 * 只更新 series.json 的 currentRelativePath/updatedAt，历史 snapshot 不动。
 *
 * series.json 是本模块唯一读写的文件；快照目录由 DesktopRevisionStore 负责。
 */
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { RevisionSeriesManifest } from "../../../shared/revisions/types.js";
import { atomicWriteJson } from "../filesystem/FileOperationJournal.js";
import {
  createRevisionId,
  resolveRevisionSeriesRoot,
  seriesDirPath,
} from "./DesktopRevisionStore.js";

export const STABLE_SERIES_PREFIX = "sn_";
export const PATH_ONLY_SERIES_PREFIX = "sp_";

/**
 * stableNoteId 可直接做目录名的形态（E1 生成的 ULID 天然满足；
 * 外部文档的奇异 id 退化为 path-only，不把任意字符串带上文件系统）。
 */
const SAFE_STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,198}$/;

/**
 * stableNoteId → 确定性 seriesId；id 形态不适合做目录名时返回 null
 * （调用方按 path-only 处理）。
 */
export function seriesIdForStableNoteId(stableNoteId: string): string | null {
  return SAFE_STABLE_ID.test(stableNoteId)
    ? `${STABLE_SERIES_PREFIX}${stableNoteId}`
    : null;
}

/* ------------------------------------------------------------------ */
/* series.json 读写                                                    */
/* ------------------------------------------------------------------ */

function isSeriesManifest(value: unknown): value is RevisionSeriesManifest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.seriesId === "string" &&
    (typeof v.stableNoteId === "string" || v.stableNoteId === null) &&
    typeof v.currentRelativePath === "string" &&
    typeof v.createdAt === "string" &&
    typeof v.updatedAt === "string"
  );
}

/**
 * 读 series.json；missing / corrupt / unknown version 一律返回 null
 * （series.json 只是身份元数据：stable 系列可由目录名重建，path-only
 * 系列读不回则不猜测、保持孤儿）。
 */
async function readSeriesManifest(
  vaultRoot: string,
  seriesId: string,
): Promise<RevisionSeriesManifest | null> {
  try {
    const seriesRoot = await resolveRevisionSeriesRoot(vaultRoot);
    const raw = await readFile(
      join(seriesDirPath(seriesRoot, seriesId), "series.json"),
      "utf8",
    );
    const parsed: unknown = JSON.parse(raw);
    return isSeriesManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 扫描全部 series 的有效 series.json（损坏条目静默跳过）。 */
async function listSeriesManifests(
  vaultRoot: string,
): Promise<RevisionSeriesManifest[]> {
  let seriesRoot: string;
  try {
    seriesRoot = await resolveRevisionSeriesRoot(vaultRoot);
  } catch {
    return [];
  }
  let entries;
  try {
    entries = await readdir(seriesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const manifests: RevisionSeriesManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = await readSeriesManifest(vaultRoot, entry.name);
    if (manifest) manifests.push(manifest);
  }
  return manifests;
}

/** 创建 series（series.json 原子写；目录缺失时自建）。 */
async function createSeries(
  vaultRoot: string,
  seriesId: string,
  stableNoteId: string | null,
  currentRelativePath: string,
): Promise<RevisionSeriesManifest> {
  const seriesRoot = await resolveRevisionSeriesRoot(vaultRoot);
  const dir = seriesDirPath(seriesRoot, seriesId);
  const now = new Date().toISOString();
  const manifest: RevisionSeriesManifest = {
    version: 1,
    seriesId,
    stableNoteId,
    currentRelativePath,
    createdAt: now,
    updatedAt: now,
  };
  await mkdir(dir, { recursive: true });
  await atomicWriteJson(join(dir, "series.json"), manifest);
  return manifest;
}

/* ------------------------------------------------------------------ */
/* 解析与路径维护                                                      */
/* ------------------------------------------------------------------ */

export interface ResolveSeriesInput {
  /** Frontmatter stable id；无 id（path-only 文档）传 null。 */
  stableNoteId: string | null;
  /** 当前 Vault 内相对路径。 */
  relativePath: string;
}

/**
 * 解析（必要时创建）文档对应的 revision series。
 * 只读既有 series（不静默改路径——路径更新一律走 relocate），
 * 找不到时新建并落盘 series.json。
 */
export async function resolveSeries(
  vaultRoot: string,
  input: ResolveSeriesInput,
): Promise<RevisionSeriesManifest> {
  // stable-id 优先：确定性派生，rename/move 后历史不变。
  if (input.stableNoteId !== null) {
    const derived = seriesIdForStableNoteId(input.stableNoteId);
    if (derived !== null) {
      const existing = await readSeriesManifest(vaultRoot, derived);
      if (existing) return existing;
      return createSeries(
        vaultRoot,
        derived,
        input.stableNoteId,
        input.relativePath,
      );
    }
    // 奇异 stable id 退化为 path-only（不猜测、不污染文件系统）。
  }

  // path-only：按当前路径匹配已有孤儿 series；外部移动不猜测（找不到新建）。
  const all = await listSeriesManifests(vaultRoot);
  const match = all.find(
    (m) =>
      m.stableNoteId === null && m.currentRelativePath === input.relativePath,
  );
  if (match) return match;
  return createSeries(
    vaultRoot,
    `${PATH_ONLY_SERIES_PREFIX}${createRevisionId()}`,
    null,
    input.relativePath,
  );
}

/**
 * R012 Stage 2：只读解析既有 series（不创建）——list/get/prune/purgeSeries
 * 等只读/清理通道用，避免读路径产生落盘副作用。
 * - stable-id 系列：直接返回确定性派生 id（即使 series.json 缺失/损坏，
 *   快照目录仍可按 id 定位，读路径不丢历史）；
 * - path-only：按当前路径匹配已有孤儿 series，找不到返回 null。
 */
export async function findSeriesId(
  vaultRoot: string,
  input: ResolveSeriesInput,
): Promise<string | null> {
  if (input.stableNoteId !== null) {
    const derived = seriesIdForStableNoteId(input.stableNoteId);
    if (derived !== null) return derived;
    // 奇异 stable id 退化为 path-only（与 resolveSeries 同口径）。
  }
  const all = await listSeriesManifests(vaultRoot);
  return (
    all.find(
      (m) =>
        m.stableNoteId === null && m.currentRelativePath === input.relativePath,
    )?.seriesId ?? null
  );
}

export interface RelocateSeriesKey {
  /** stable-id 系列：确定性派生定位。 */
  stableNoteId?: string | null;
  /** 直接按 seriesId 定位。 */
  seriesId?: string;
  /** path-only 兜底：按当前路径匹配孤儿 series。 */
  fromRelativePath?: string;
}

/**
 * R011 文档 rename/move 的 series 路径同步：只更新 series.json 的
 * currentRelativePath/updatedAt，快照不动。
 * @returns 是否命中并更新了某个 series。
 */
export async function relocateSeries(
  vaultRoot: string,
  key: RelocateSeriesKey,
  newRelativePath: string,
): Promise<boolean> {
  let manifest: RevisionSeriesManifest | null = null;
  const derived =
    key.stableNoteId != null ? seriesIdForStableNoteId(key.stableNoteId) : null;
  if (derived !== null) {
    manifest = await readSeriesManifest(vaultRoot, derived);
  }
  if (!manifest && key.seriesId) {
    manifest = await readSeriesManifest(vaultRoot, key.seriesId);
  }
  if (!manifest && key.fromRelativePath) {
    const all = await listSeriesManifests(vaultRoot);
    manifest =
      all.find(
        (m) =>
          m.stableNoteId === null &&
          m.currentRelativePath === key.fromRelativePath,
      ) ?? null;
  }
  if (!manifest) return false;
  await writeSeriesPath(vaultRoot, manifest, newRelativePath);
  return true;
}

/**
 * R011 分组 rename/move 的批量路径同步：currentRelativePath 等于 oldPrefix
 * 或位于其下的 series 统一改前缀。
 * @returns 更新的 series 数。
 */
export async function relocateSeriesPrefix(
  vaultRoot: string,
  oldPrefix: string,
  newPrefix: string,
): Promise<number> {
  const all = await listSeriesManifests(vaultRoot);
  let updated = 0;
  for (const manifest of all) {
    const path = manifest.currentRelativePath;
    if (path !== oldPrefix && !path.startsWith(`${oldPrefix}/`)) continue;
    const next = `${newPrefix}${path.slice(oldPrefix.length)}`;
    await writeSeriesPath(vaultRoot, manifest, next);
    updated += 1;
  }
  return updated;
}

async function writeSeriesPath(
  vaultRoot: string,
  manifest: RevisionSeriesManifest,
  newRelativePath: string,
): Promise<void> {
  const seriesRoot = await resolveRevisionSeriesRoot(vaultRoot);
  const next: RevisionSeriesManifest = {
    ...manifest,
    currentRelativePath: newRelativePath,
    updatedAt: new Date().toISOString(),
  };
  await atomicWriteJson(
    join(seriesDirPath(seriesRoot, manifest.seriesId), "series.json"),
    next,
  );
}
