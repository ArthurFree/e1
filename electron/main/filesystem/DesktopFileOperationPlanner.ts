/**
 * R011：Main 侧文件操作预检规划器——根据请求生成 FileOperationPlan。
 * dirty 状态由 Renderer 追加 blocker；本模块只做路径/链接/碰撞分析。
 */
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import { IpcFailure } from "../../../shared/errors.js";
import type {
  FileOperationPlanDto,
  FileOperationPlanInput,
  FilePathMoveDto,
  MarkdownLinkPatchPlanDto,
} from "../../../shared/ipc/contracts.js";
import { splitFrontmatter } from "../../../shared/markdown/frontmatter.js";
import { detectUnsupportedLinkSyntax } from "../../../shared/links/detectUnsupportedLinkSyntax.js";
import { applyPathMoves } from "../../../shared/links/relocateHref.js";
import { isSelfOrDescendant } from "./JournaledFileOperationEngine.js";
import {
  assertNotReservedPath,
  resolveAssetsDirectory,
} from "./VaultFileOperations.js";
import type { DesktopLinkDatabase } from "../links/DesktopLinkDatabase.js";
import { readNoteFile } from "./NoteFileSystem.js";

function newOperationId(): string {
  return `op_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

function parentDir(relativePath: string): string {
  const i = relativePath.lastIndexOf("/");
  return i === -1 ? "" : relativePath.slice(0, i);
}

async function listMarkdownUnder(
  vaultRoot: string,
  dirRel: string,
): Promise<string[]> {
  const abs = dirRel ? join(vaultRoot, ...dirRel.split("/")) : vaultRoot;
  const out: string[] = [];
  async function walk(rel: string, absDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = join(absDir, entry.name);
      if (entry.isDirectory()) await walk(childRel, childAbs);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) out.push(childRel);
    }
  }
  await walk(dirRel, abs);
  return out;
}

async function noteKeyFor(
  vaultRoot: string,
  relativePath: string,
): Promise<string> {
  try {
    const file = await readNoteFile({ vaultRoot, relativePath });
    const { metadata } = splitFrontmatter(file.markdown.replace(/\r\n/g, "\n"));
    if (metadata.id) return metadata.id;
  } catch {
    // fallthrough
  }
  return `path:${relativePath}`;
}

export async function planFileOperation(input: {
  vaultRoot: string;
  request: FileOperationPlanInput;
  links: DesktopLinkDatabase;
}): Promise<FileOperationPlanDto> {
  const { vaultRoot, request, links } = input;
  const assetsDirectory = await resolveAssetsDirectory(vaultRoot);
  const operationId = newOperationId();
  const blockers: FileOperationPlanDto["blockers"] = [];
  const warnings: FileOperationPlanDto["warnings"] = [];

  if (request.kind === "rename-workspace") {
    const name = request.workspaceName?.trim() ?? "";
    if (!name) {
      blockers.push({
        code: "INVALID_INPUT",
        message: "知识库名称不能为空。",
      });
    }
    return {
      operationId,
      kind: request.kind,
      vaultId: request.vaultId,
      target: { workspaceName: name },
      pathMoves: [],
      patches: [],
      summary: {
        movedDocuments: 0,
        rewrittenDocuments: 0,
        rewrittenLinks: 0,
        rewrittenAssets: 0,
      },
      blockers,
      warnings,
      createdAt: Date.now(),
    };
  }

  const from = request.fromRelativePath;
  if (!from) {
    throw new IpcFailure("INVALID_INPUT", "缺少 fromRelativePath");
  }
  assertNotReservedPath(from, assetsDirectory);

  let pathMoves: FilePathMoveDto[];

  if (request.kind === "rename-document-file") {
    const newName = request.newName?.trim();
    if (!newName || !/\.md$/i.test(newName)) {
      throw new IpcFailure("INVALID_INPUT", "新文件名必须以 .md 结尾");
    }
    const parent = parentDir(from);
    const to = parent ? `${parent}/${newName}` : newName;
    pathMoves = [
      {
        noteKey: await noteKeyFor(vaultRoot, from),
        kind: "document",
        fromRelativePath: from,
        toRelativePath: to,
      },
    ];
  } else if (request.kind === "move-document") {
    const targetDir = request.toRelativePath ?? "";
    if (targetDir) assertNotReservedPath(targetDir, assetsDirectory);
    const to = targetDir ? `${targetDir}/${basename(from)}` : basename(from);
    pathMoves = [
      {
        noteKey: await noteKeyFor(vaultRoot, from),
        kind: "document",
        fromRelativePath: from,
        toRelativePath: to,
      },
    ];
  } else if (
    request.kind === "rename-group" ||
    request.kind === "move-group"
  ) {
    let to: string;
    if (request.kind === "rename-group") {
      const newName = request.newName?.trim();
      if (!newName) throw new IpcFailure("INVALID_INPUT", "分组名不能为空");
      const parent = parentDir(from);
      to = parent ? `${parent}/${newName}` : newName;
    } else {
      const targetDir = request.toRelativePath ?? "";
      if (targetDir) {
        assertNotReservedPath(targetDir, assetsDirectory);
        if (isSelfOrDescendant(targetDir, from) || targetDir === from) {
          blockers.push({
            code: "INVALID_INPUT",
            message: "不能将分组移动到自身或其子目录中。",
          });
        }
      }
      to = targetDir ? `${targetDir}/${basename(from)}` : basename(from);
    }
    if (isSelfOrDescendant(to, from) && to !== from) {
      blockers.push({
        code: "INVALID_INPUT",
        message: "不能将分组移动到自身或其子目录中。",
      });
    }
    const docs = await listMarkdownUnder(vaultRoot, from);
    const prefixMove = [
      { fromRelativePath: from, toRelativePath: to },
    ];
    pathMoves = [
      {
        noteKey: null,
        kind: "group",
        fromRelativePath: from,
        toRelativePath: to,
      },
    ];
    for (const docPath of docs) {
      pathMoves.push({
        noteKey: await noteKeyFor(vaultRoot, docPath),
        kind: "document",
        fromRelativePath: docPath,
        toRelativePath: applyPathMoves(docPath, prefixMove),
      });
    }
  } else {
    throw new IpcFailure("INVALID_INPUT", `未知操作种类：${request.kind}`);
  }

  const enriched = pathMoves
    .filter((m) => m.kind === "document" && m.noteKey)
    .map((m) => ({
      noteKey: m.noteKey!,
      fromRelativePath: m.fromRelativePath,
      toRelativePath: m.toRelativePath,
    }));

  const impacts = await links.analyzeRelocation({
    vaultId: request.vaultId,
    pathMoves: enriched,
  });

  const bySource = new Map<string, MarkdownLinkPatchPlanDto>();
  let rewrittenLinks = 0;
  let rewrittenAssets = 0;
  for (const impact of impacts) {
    let patch = bySource.get(impact.sourcePageId);
    if (!patch) {
      let versionToken: string;
      try {
        const file = await readNoteFile({
          vaultRoot,
          relativePath: impact.sourceRelativePath,
        });
        versionToken = file.versionToken;
        for (const w of detectUnsupportedLinkSyntax(file.markdown)) {
          warnings.push({
            code: w.code,
            message: w.message,
            pageId: impact.sourcePageId,
            relativePath: impact.sourceRelativePath,
          });
        }
      } catch {
        blockers.push({
          code: "FILE_OPERATION_STALE_PLAN",
          message: `无法读取受影响文档：${impact.sourceRelativePath}`,
          relativePath: impact.sourceRelativePath,
        });
        continue;
      }
      patch = {
        sourcePageId: impact.sourcePageId,
        sourceRelativePathBefore: impact.sourceRelativePath,
        sourceRelativePathAfter: impact.futureSourceRelativePath,
        expectedVersionToken: versionToken,
        rules: [],
      };
      bySource.set(impact.sourcePageId, patch);
    }
    patch.rules.push({
      kind: impact.kind,
      oldHref: impact.oldHref,
      newHref: impact.newHref,
    });
    if (impact.kind === "asset") rewrittenAssets += 1;
    else rewrittenLinks += 1;
  }

  const patches = [...bySource.values()];
  const primary = pathMoves.find((m) => m.fromRelativePath === from);
  const docMoves = pathMoves.filter((m) => m.kind === "document");

  return {
    operationId,
    kind: request.kind,
    vaultId: request.vaultId,
    target: {
      fromRelativePath: from,
      toRelativePath: primary?.toRelativePath,
    },
    // execute 时目录 rename 一次即可；文档 pathMoves 仅用于索引 reconcile。
    pathMoves:
      request.kind === "rename-group" || request.kind === "move-group"
        ? pathMoves.filter((m) => m.kind === "group")
        : pathMoves,
    patches,
    summary: {
      movedDocuments: docMoves.length,
      rewrittenDocuments: patches.length,
      rewrittenLinks,
      rewrittenAssets,
    },
    blockers,
    warnings,
    createdAt: Date.now(),
  };
}
