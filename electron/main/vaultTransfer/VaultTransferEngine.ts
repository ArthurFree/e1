/**
 * R014 Stage 3–4：跨 Vault Copy / Move。
 * Renderer 只传 vaultId + relativePath；绝对路径只在 Main。
 */
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { IpcFailure } from "../../../shared/errors.js";
import { extractMarkdownLinks } from "../../../shared/links/extractMarkdownLinks.js";
import { classifyLinkHref, resolveLinkPath } from "../../../shared/links/linkKind.js";
import { relocateHref } from "../../../shared/links/relocateHref.js";
import { rewriteMarkdownLinkDestinations } from "../../../shared/links/rewriteMarkdownLinkDestinations.js";
import {
  generateFrontmatter,
  splitFrontmatter,
} from "../../../shared/markdown/frontmatter.js";
import { classifyBoundaryLink } from "../../../shared/vaultTransfer/boundary.js";
import type {
  VaultTransferAssetPlan,
  VaultTransferIssue,
  VaultTransferKind,
  VaultTransferNotePlan,
  VaultTransferPlan,
  VaultTransferResult,
} from "../../../shared/vaultTransfer/types.js";
import { VAULT_TRANSFER_BLOCKER_CODES as CODES } from "../../../shared/vaultTransfer/types.js";
import { scanVault } from "../filesystem/VaultFileSystem.js";
import { trashEntry } from "../filesystem/VaultTrashFileSystem.js";
import {
  resolveRevisionSeriesRoot,
  seriesDirPath,
} from "../revisions/DesktopRevisionStore.js";
import { seriesIdForStableNoteId } from "../revisions/DesktopRevisionIdentity.js";
import { resolveVaultRoot, type VaultRootDeps } from "../vaultRoots.js";
import { copyDirectoryContents, pathExists } from "./walkHash.js";
import { emptyTransferPlan } from "./VaultRelocationEngine.js";

function posixJoin(...parts: string[]): string {
  return parts.filter((p) => p.length > 0).join("/");
}

function parentPosix(relativePath: string): string {
  const i = relativePath.lastIndexOf("/");
  return i === -1 ? "" : relativePath.slice(0, i);
}

function basenamePosix(relativePath: string): string {
  const i = relativePath.lastIndexOf("/");
  return i === -1 ? relativePath : relativePath.slice(i + 1);
}

function collisionName(fileName: string, attempt: number): string {
  if (attempt === 0) return fileName;
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return `${fileName} (${attempt + 1})`;
  return `${fileName.slice(0, dot)} (${attempt + 1})${fileName.slice(dot)}`;
}

async function uniqueDestPath(
  destRoot: string,
  relativePath: string,
): Promise<string> {
  const dir = parentPosix(relativePath);
  const name = basenamePosix(relativePath);
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = posixJoin(dir, collisionName(name, attempt));
    if (!(await pathExists(join(destRoot, ...candidate.split("/"))))) {
      return candidate;
    }
  }
  throw new IpcFailure("VAULT_PATH_COLLISION", `无法为 ${relativePath} 分配不冲突路径`);
}

function replaceFrontmatterId(markdown: string, newId: string): string {
  const crlf = markdown.includes("\r\n");
  const normalized = markdown.replace(/\r\n/g, "\n");
  const split = splitFrontmatter(normalized);
  const fm = generateFrontmatter({
    id: newId,
    title: split.metadata.title,
    tags: split.metadata.tags.length > 0 ? split.metadata.tags : undefined,
    createdAt: split.metadata.createdAt,
    updatedAt: split.metadata.updatedAt,
    aliases:
      split.metadata.aliases.length > 0 ? split.metadata.aliases : undefined,
    extra: split.metadata.extra,
  });
  const next = split.body.length > 0 ? `${fm}\n\n${split.body}` : `${fm}\n\n`;
  return crlf ? next.replace(/\n/g, "\r\n") : next;
}

async function fileSha256(abs: string): Promise<string> {
  const bytes = await readFile(abs);
  return createHash("sha256").update(bytes).digest("hex");
}

export async function planCrossVaultTransfer(input: {
  kind: Extract<
    VaultTransferKind,
    "copy-document" | "copy-group" | "move-document" | "move-group"
  >;
  sourceVaultId: string;
  destinationVaultId: string;
  sourceRelativePath: string;
  destinationRelativePath: string;
  roots: VaultRootDeps;
}): Promise<VaultTransferPlan> {
  const operationId = randomUUID();
  const blockers: VaultTransferIssue[] = [];
  const warnings: VaultTransferIssue[] = [];
  if (input.sourceVaultId === input.destinationVaultId) {
    blockers.push({
      code: CODES.destSameVault,
      message: "源与目标不能是同一个知识库。",
    });
  }
  const sourceRoot = await resolveVaultRoot(input.sourceVaultId, input.roots);
  const destRoot = await resolveVaultRoot(input.destinationVaultId, input.roots);
  if (sourceRoot.transient || destRoot.transient) {
    throw new IpcFailure("VAULT_READ_ONLY", "预览会话不支持跨库操作。");
  }
  const sourceScan = await scanVault(sourceRoot.absolutePath);
  const destScan = await scanVault(destRoot.absolutePath);
  const assetsDir = sourceScan.vault.assetsDirectory ?? "assets";
  const destAssetsDir = destScan.vault.assetsDirectory ?? "assets";

  const prefix = input.sourceRelativePath;
  const inSet = sourceScan.entries.filter((entry) => {
    if (entry.relativePath === prefix) return true;
    return prefix.length > 0 && entry.relativePath.startsWith(`${prefix}/`);
  });
  if (inSet.length === 0) {
    blockers.push({
      code: "NOTE_NOT_FOUND",
      message: `源路径不存在：${prefix}`,
    });
  }
  const docs = inSet.filter((e) => e.kind === "document");
  const groups = inSet.filter((e) => e.kind === "group");
  const isMove = input.kind.startsWith("move-");
  const isGroup = input.kind.endsWith("-group");
  const destParent = input.destinationRelativePath;
  const directories: Array<{ sourcePath: string; destinationPath: string }> =
    [];
  let destRootRelative = destParent;

  if (isGroup && prefix.length > 0) {
    const groupName = basenamePosix(prefix);
    let intendedGroup = posixJoin(destParent, groupName);
    const destAbs = join(
      destRoot.absolutePath,
      ...intendedGroup.split("/").filter(Boolean),
    );
    if (await pathExists(destAbs)) {
      if (isMove) {
        blockers.push({
          code: CODES.collision,
          message: `目标已存在，移动拒绝覆盖：${intendedGroup}`,
          relativePath: intendedGroup,
        });
      } else {
        intendedGroup = await uniqueDestPath(
          destRoot.absolutePath,
          intendedGroup,
        );
        warnings.push({
          code: "VAULT_TRANSFER_RENAMED",
          message: `目标重名，将保存为 ${intendedGroup}`,
          relativePath: intendedGroup,
        });
      }
    }
    destRootRelative = intendedGroup;
    directories.push({ sourcePath: prefix, destinationPath: destRootRelative });
    for (const group of groups) {
      if (group.relativePath === prefix) continue;
      const rel = group.relativePath.slice(prefix.length).replace(/^\//, "");
      directories.push({
        sourcePath: group.relativePath,
        destinationPath: posixJoin(destRootRelative, rel),
      });
    }
  }

  const notes: VaultTransferNotePlan[] = [];
  const sourceFingerprintParts: string[] = [];

  for (const doc of docs) {
    let intended: string;
    if (isGroup) {
      const rel =
        prefix === doc.relativePath
          ? basenamePosix(doc.relativePath)
          : doc.relativePath.slice(prefix.length).replace(/^\//, "");
      intended = posixJoin(destRootRelative, rel);
    } else {
      intended = posixJoin(destParent, basenamePosix(doc.relativePath));
    }
    let destinationPath = intended;
    const destExists = destScan.entries.some(
      (e) => e.relativePath === intended,
    );
    if (!isGroup && destExists) {
      if (isMove) {
        blockers.push({
          code: CODES.collision,
          message: `目标已存在，移动拒绝覆盖：${intended}`,
          relativePath: intended,
        });
      } else {
        destinationPath = await uniqueDestPath(
          destRoot.absolutePath,
          intended,
        );
        warnings.push({
          code: "VAULT_TRANSFER_RENAMED",
          message: `目标重名，将保存为 ${destinationPath}`,
          relativePath: destinationPath,
        });
      }
    }
    const abs = join(sourceRoot.absolutePath, ...doc.relativePath.split("/"));
    const markdown = await readFile(abs, "utf8");
    const stable = splitFrontmatter(markdown).metadata.id ?? doc.noteId;
    const destinationStableId = isMove
      ? (stable ?? randomUUID())
      : randomUUID();
    notes.push({
      sourcePath: doc.relativePath,
      destinationPath,
      sourceStableId: stable ?? null,
      destinationStableId,
    });
    sourceFingerprintParts.push(`${doc.relativePath}:${await fileSha256(abs)}`);
  }

  const setPaths = new Set(docs.map((d) => d.relativePath));
  const classes = [];
  for (const entry of sourceScan.entries) {
    if (entry.kind !== "document") continue;
    const abs = join(sourceRoot.absolutePath, ...entry.relativePath.split("/"));
    let markdown: string;
    try {
      markdown = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    const sourceInSet = setPaths.has(entry.relativePath);
    for (const link of extractMarkdownLinks(markdown, entry.relativePath)) {
      if (classifyLinkHref(link.href).kind !== "internal") continue;
      const target = resolveLinkPath(entry.relativePath, link.href);
      if (!target) continue;
      const targetInSet = setPaths.has(target);
      if (!sourceInSet && !targetInSet) continue;
      classes.push(classifyBoundaryLink({ sourceInSet, targetInSet }));
    }
  }
  let internal = 0;
  let inboundBoundary = 0;
  let outboundBoundary = 0;
  for (const item of classes) {
    if (item === "inside-inside") internal += 1;
    else if (item === "outside-inside") inboundBoundary += 1;
    else outboundBoundary += 1;
  }
  if (isMove && inboundBoundary > 0) {
    blockers.push({
      code: CODES.boundaryInbound,
      message: `库内仍有 ${inboundBoundary} 条链接指向将被移走的文档，拒绝移动以免产生失效链接。`,
    });
  }
  if (isMove && outboundBoundary > 0) {
    blockers.push({
      code: CODES.boundaryOutbound,
      message: `选中文档仍有 ${outboundBoundary} 条链接指向库内其他文档，拒绝移动以免产生失效链接。`,
    });
  }
  if (!isMove && (inboundBoundary > 0 || outboundBoundary > 0)) {
    warnings.push({
      code: "VAULT_TRANSFER_BOUNDARY_WARNING",
      message: `复制后将有跨边界链接（入 ${inboundBoundary} / 出 ${outboundBoundary}），目标库可能出现失效引用。`,
    });
  }

  const assets: VaultTransferAssetPlan[] = [];
  const destAssetHashes = new Map<string, string>();
  const destAssetRoot = join(destRoot.absolutePath, destAssetsDir);
  if (await pathExists(destAssetRoot)) {
    const listed = await readdir(destAssetRoot, { withFileTypes: true }).catch(
      () => [],
    );
    for (const item of listed) {
      if (!item.isFile()) continue;
      const abs = join(destAssetRoot, item.name);
      destAssetHashes.set(await fileSha256(abs), posixJoin(destAssetsDir, item.name));
    }
  }
  const seenAssets = new Set<string>();
  for (const note of notes) {
    const abs = join(sourceRoot.absolutePath, ...note.sourcePath.split("/"));
    const markdown = await readFile(abs, "utf8");
    for (const link of extractMarkdownLinks(markdown, note.sourcePath)) {
      if (classifyLinkHref(link.href).kind !== "asset") continue;
      const target = resolveLinkPath(note.sourcePath, link.href);
      if (!target || !target.startsWith(`${assetsDir}/`)) continue;
      if (seenAssets.has(target)) continue;
      seenAssets.add(target);
      const srcAbs = join(sourceRoot.absolutePath, ...target.split("/"));
      if (!(await pathExists(srcAbs))) continue;
      const sha256 = await fileSha256(srcAbs);
      const reuse = destAssetHashes.get(sha256);
      let destinationPath =
        reuse ?? posixJoin(destAssetsDir, basenamePosix(target));
      if (!reuse) {
        const intended = destinationPath;
        destinationPath = await uniqueDestPath(
          destRoot.absolutePath,
          intended,
        );
        if (destinationPath !== intended) {
          warnings.push({
            code: "VAULT_TRANSFER_RENAMED",
            message: `附件重名，将保存为 ${destinationPath}`,
            relativePath: destinationPath,
          });
        }
      }
      assets.push({
        sourcePath: target,
        destinationPath,
        sha256,
        reuseExisting: Boolean(reuse),
      });
    }
  }

  const revisions = isMove
    ? notes
        .filter((n) => n.sourceStableId)
        .map((n) => ({
          sourceSeriesId: seriesIdForStableNoteId(n.sourceStableId!) ?? "",
          destinationSeriesId: seriesIdForStableNoteId(n.destinationStableId) ?? "",
          stableNoteId: n.destinationStableId,
        }))
        .filter((r) => r.sourceSeriesId && r.destinationSeriesId)
    : [];

  return emptyTransferPlan({
    operationId,
    kind: input.kind,
    sourceVaultId: input.sourceVaultId,
    destinationVaultId: input.destinationVaultId,
    sourceRelativePath: input.sourceRelativePath,
    destinationRelativePath: input.destinationRelativePath,
    notes,
    directories,
    assets,
    revisions,
    linkImpacts: { internal, inboundBoundary, outboundBoundary },
    blockers,
    warnings,
    sourceFingerprint: sourceFingerprintParts.sort().join("|"),
    destinationFingerprint: [
      ...directories.map((d) => d.destinationPath),
      ...notes.map((n) => n.destinationPath),
    ]
      .sort()
      .join("|"),
  });
}

export async function executeCrossVaultTransfer(input: {
  plan: VaultTransferPlan;
  roots: VaultRootDeps;
}): Promise<VaultTransferResult> {
  const plan = input.plan;
  if (plan.blockers.length > 0) {
    throw new IpcFailure(
      "INVALID_INPUT",
      plan.blockers[0]?.message ?? "无法执行跨库操作",
    );
  }
  const kind = plan.kind;
  if (
    kind !== "copy-document" &&
    kind !== "copy-group" &&
    kind !== "move-document" &&
    kind !== "move-group"
  ) {
    throw new IpcFailure("INVALID_INPUT", `不支持的跨库 kind：${kind}`);
  }
  const destVaultId = plan.destinationVaultId;
  if (!destVaultId) {
    throw new IpcFailure("INVALID_INPUT", "缺少目标知识库");
  }
  const replay = await planCrossVaultTransfer({
    kind,
    sourceVaultId: plan.sourceVaultId,
    destinationVaultId: destVaultId,
    sourceRelativePath: plan.sourceRelativePath ?? "",
    destinationRelativePath: plan.destinationRelativePath ?? "",
    roots: input.roots,
  });
  if (replay.sourceFingerprint !== plan.sourceFingerprint) {
    throw new IpcFailure(
      "VAULT_TRANSFER_STALE_PLAN",
      "源文档在预检后已变化，请重新计划。",
    );
  }
  if (replay.destinationFingerprint !== plan.destinationFingerprint) {
    throw new IpcFailure(
      "VAULT_TRANSFER_STALE_PLAN",
      "目标知识库在预检后已变化，请重新计划。",
    );
  }
  if (replay.blockers.some((b) => b.code === CODES.collision)) {
    throw new IpcFailure(
      "VAULT_TRANSFER_STALE_PLAN",
      "目标路径在预检后已被占用，请重新计划。",
    );
  }

  const sourceRoot = await resolveVaultRoot(plan.sourceVaultId, input.roots);
  const destRoot = await resolveVaultRoot(destVaultId, input.roots);
  const isMove = kind.startsWith("move-");
  const isCopy = !isMove;
  const pathMoves = plan.notes.map((n) => ({
    fromRelativePath: n.sourcePath,
    toRelativePath: n.destinationPath,
  }));
  const idBySource = new Map(
    plan.notes.map((n) => [n.sourcePath, n.destinationStableId]),
  );

  for (const dir of plan.directories) {
    const destDir = join(
      destRoot.absolutePath,
      ...dir.destinationPath.split("/").filter(Boolean),
    );
    if (dir.destinationPath) {
      await mkdir(destDir, { recursive: true });
    }
  }

  for (const asset of plan.assets) {
    if (asset.reuseExisting) continue;
    const from = join(sourceRoot.absolutePath, ...asset.sourcePath.split("/"));
    const to = join(destRoot.absolutePath, ...asset.destinationPath.split("/"));
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  }

  for (const note of plan.notes) {
    const destDir = join(
      destRoot.absolutePath,
      ...parentPosix(note.destinationPath).split("/").filter(Boolean),
    );
    if (parentPosix(note.destinationPath)) {
      await mkdir(destDir, { recursive: true });
    }
    const from = join(sourceRoot.absolutePath, ...note.sourcePath.split("/"));
    let markdown = await readFile(from, "utf8");
    if (isCopy) {
      markdown = replaceFrontmatterId(markdown, note.destinationStableId);
    }
    const rules: Array<{ oldHref: string; newHref: string }> = [];
    for (const link of extractMarkdownLinks(markdown, note.sourcePath)) {
      const kindLink = classifyLinkHref(link.href).kind;
      const target = resolveLinkPath(note.sourcePath, link.href);
      if (!target) continue;
      if (kindLink === "internal") {
        const mapped = pathMoves.find((m) => m.fromRelativePath === target);
        if (!mapped) continue;
        const relocated = relocateHref({
          sourcePathBefore: note.sourcePath,
          targetPathBefore: target,
          sourcePathAfter: note.destinationPath,
          targetPathAfter: mapped.toRelativePath,
          oldHref: link.href,
        });
        if (relocated.changed) {
          rules.push({ oldHref: link.href, newHref: relocated.newHref });
        }
      }
      if (kindLink === "asset") {
        const mapped = plan.assets.find((a) => a.sourcePath === target);
        if (!mapped) continue;
        const relocated = relocateHref({
          sourcePathBefore: note.sourcePath,
          targetPathBefore: target,
          sourcePathAfter: note.destinationPath,
          targetPathAfter: mapped.destinationPath,
          oldHref: link.href,
        });
        if (relocated.changed) {
          rules.push({ oldHref: link.href, newHref: relocated.newHref });
        }
      }
    }
    if (rules.length > 0) {
      markdown = rewriteMarkdownLinkDestinations(markdown, rules).markdown;
    }
    const to = join(destRoot.absolutePath, ...note.destinationPath.split("/"));
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, markdown, { encoding: "utf8", flag: "wx" });
    void idBySource;
  }

  if (isMove) {
    for (const rev of plan.revisions) {
      const srcSeriesRoot = await resolveRevisionSeriesRoot(
        sourceRoot.absolutePath,
      );
      const destSeriesRoot = await resolveRevisionSeriesRoot(
        destRoot.absolutePath,
      );
      const from = seriesDirPath(srcSeriesRoot, rev.sourceSeriesId);
      const to = seriesDirPath(destSeriesRoot, rev.destinationSeriesId);
      if (await pathExists(from)) {
        await copyDirectoryContents(from, to);
      }
    }
    const top = plan.sourceRelativePath ?? commonPrefix(plan.notes.map((n) => n.sourcePath));
    await trashEntry({
      vaultRoot: sourceRoot.absolutePath,
      relativePath: top,
      crossVaultMovedToVaultId: destVaultId,
    });
  }

  return {
    operationId: plan.operationId,
    kind,
    sourceVaultId: plan.sourceVaultId,
    destinationVaultId: destVaultId,
    notesCopied: plan.notes.length,
    assetsCopied: plan.assets.filter((a) => !a.reuseExisting).length,
    revisionsTransferred: isMove ? plan.revisions.length : 0,
    sourceTrashed: isMove,
  };
}

function commonPrefix(paths: string[]): string {
  if (paths.length === 0) return "";
  const sorted = [...paths].sort();
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  let i = 0;
  while (i < first.length && first[i] === last[i]) i += 1;
  const shared = first.slice(0, i);
  const cut = shared.lastIndexOf("/");
  if (paths.every((p) => p === first)) return first;
  return cut === -1 ? shared.replace(/\/[^/]*$/, "") || first.split("/")[0]! : shared.slice(0, cut);
}
