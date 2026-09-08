/**
 * R012 Stage 2（需求 §21/§44）：revision 组 IPC handler——Desktop 版本历史
 *（`.e1/revisions/` 不可变快照，electron/main/revisions/）的
 * 列表/读取/捕获/裁剪/搬迁/清理通道。
 *
 * 安全边界（§44）：
 * - 请求只允许 vaultId + 身份字段（relativePath / stableNoteId? /
 *   seriesId?）+ revisionId + reason + expectedVersionToken + keep/maxBytes；
 *   禁止 absolutePath（schema 层拒绝，resolveVaultRoot 由 Main 侧解析）；
 * - Renderer 不传任何正文：capture 由 Main 重读磁盘当前 Markdown 为准
 *  （REV-02），本组任何日志不得包含正文（当前实现不打日志）；
 * - 写通道（capture/prune/relocate/purgeSeries/restore）transient 仅预览拒写
 *  （VAULT_READ_ONLY，与 note 组同口径）；list/get 只读，transient 允许
 *  （与 links 组同口径）。
 *
 * revision.restore（R012 Stage 4，需求 §23 Safe Restore）：Main 复核磁盘
 * 版本令牌（DOCUMENT_CONFLICT 则不写任何字节）→ 读当前 Frontmatter →
 * 取历史 raw body → 保留当前 Frontmatter（仅 updated 推进）拼回 →
 * AtomicFileWriter 落盘（BOM 跟随磁盘现状）。handler 永不 throw
 *（统一 IpcResult 信封——业务失败以 IpcFailure 表达）。
 */
import {
  IPC_CHANNELS,
  type RevisionCaptureResult,
  type RevisionGetResult,
  type RevisionListResult,
  type RevisionPruneResult,
  type RevisionPurgeSeriesResult,
  type RevisionRelocateResult,
  type RevisionRestoreResult,
  type RevisionSummaryDto,
} from "../../../shared/ipc/contracts.js";
import { IpcFailure } from "../../../shared/errors.js";
import type { DesktopRevisionManifest } from "../../../shared/revisions/types.js";
import {
  parseRevisionCaptureInput,
  parseRevisionGetInput,
  parseRevisionListInput,
  parseRevisionPruneInput,
  parseRevisionPurgeSeriesInput,
  parseRevisionRelocateInput,
  parseRevisionRestoreInput,
} from "../../../shared/ipc/schemas.js";
import { resolveVaultRoot, type VaultRootDeps } from "../vaultRoots.js";
import { DesktopRevisionStore } from "../revisions/DesktopRevisionStore.js";
import {
  findSeriesId,
  relocateSeries,
  relocateSeriesPrefix,
  resolveSeries,
} from "../revisions/DesktopRevisionIdentity.js";
import { pruneIntervalRevisions } from "../revisions/DesktopRevisionRetention.js";
import { readNoteFile } from "../filesystem/NoteFileSystem.js";
import { atomicWriteFile } from "../filesystem/AtomicFileWriter.js";
import { resolveWithinVault } from "../filesystem/PathGuard.js";
import {
  generateFrontmatter,
  splitFrontmatter,
} from "../../../shared/markdown/frontmatter.js";
import { detectLineEnding } from "../../../shared/revisions/rawMarkdownBody.js";
import type { SelfWriteRegistry } from "../watcher/SelfWriteRegistry.js";
import { handleRequest, type IpcMainLike } from "./handler.js";

/** revision 组 handler 依赖：vaultId → Vault 根目录解析（与 note 组同模式）。 */
export type RevisionHandlerDeps = VaultRootDeps & {
  /** 自写登记（R007 阶段 3）：restore 落盘后抑制 watcher 回声。 */
  selfWrites?: SelfWriteRegistry;
};

/** manifest → wire 摘要（ISO createdAt / bodyBytes / textPreview 原样透传）。 */
function toSummaryDto(manifest: DesktopRevisionManifest): RevisionSummaryDto {
  return {
    revisionId: manifest.revisionId,
    reason: manifest.reason,
    createdAt: manifest.createdAt,
    bodyBytes: manifest.bodyBytes,
    textPreview: manifest.textPreview,
  };
}

/** 写通道统一拒绝 transient 仅预览会话（与 note 组同口径）。 */
function assertWritable(transient: boolean): void {
  if (transient) {
    throw new IpcFailure("VAULT_READ_ONLY", "仅预览知识库不能修改版本历史。");
  }
}

export function registerRevisionHandlers(
  bus: IpcMainLike,
  deps: RevisionHandlerDeps = {},
): void {
  bus.handle(
    IPC_CHANNELS.revisionList,
    handleRequest(
      parseRevisionListInput,
      async (input): Promise<RevisionListResult> => {
        const root = await resolveVaultRoot(input.vaultId, deps);
        // 只读解析（不创建 series）：读路径不产生落盘副作用。
        const seriesId = await findSeriesId(root.absolutePath, {
          stableNoteId: input.stableNoteId ?? null,
          relativePath: input.relativePath,
        });
        if (seriesId === null) return { summaries: [] };
        const store = new DesktopRevisionStore(root.absolutePath);
        const { revisions, degraded } = await store.list(seriesId);
        return {
          summaries: revisions.map(toSummaryDto),
          ...(degraded.length > 0
            ? {
                degraded: degraded.map(
                  (d) => `${d.revisionId}（${d.reason}）`,
                ),
              }
            : {}),
        };
      },
    ),
  );

  bus.handle(
    IPC_CHANNELS.revisionGet,
    handleRequest(
      parseRevisionGetInput,
      async (input): Promise<RevisionGetResult | null> => {
        const root = await resolveVaultRoot(input.vaultId, deps);
        const seriesId = await findSeriesId(root.absolutePath, {
          stableNoteId: input.stableNoteId ?? null,
          relativePath: input.relativePath,
        });
        if (seriesId === null) return null;
        const store = new DesktopRevisionStore(root.absolutePath);
        const result = await store.get(seriesId, input.revisionId);
        // 不存在/损坏同按 null 返回（与 domain RevisionRepository.get 的
        // undefined 语义对齐；损坏降级信息由 list 的 degraded 承载）。
        if (result.kind !== "ok") return null;
        return {
          revisionId: result.manifest.revisionId,
          reason: result.manifest.reason,
          createdAt: result.manifest.createdAt,
          body: result.body,
          bodyBytes: result.manifest.bodyBytes,
          lineEnding: result.manifest.lineEnding,
          relativePathAtCapture: result.manifest.relativePathAtCapture,
        };
      },
    ),
  );

  bus.handle(
    IPC_CHANNELS.revisionCapture,
    handleRequest(
      parseRevisionCaptureInput,
      async (input): Promise<RevisionCaptureResult> => {
        const root = await resolveVaultRoot(input.vaultId, deps);
        assertWritable(root.transient);
        // capture 允许创建 series（写路径）；stable-id 优先（§17）。
        const series = await resolveSeries(root.absolutePath, {
          stableNoteId: input.stableNoteId ?? null,
          relativePath: input.relativePath,
        });
        const store = new DesktopRevisionStore(root.absolutePath);
        const manifest = await store.capture({
          seriesId: series.seriesId,
          relativePath: input.relativePath,
          reason: input.reason,
          sourceVersionToken: input.sourceVersionToken ?? "",
          ...(input.expectedVersionToken !== undefined
            ? { expectedVersionToken: input.expectedVersionToken }
            : {}),
        });
        return manifest === null ? null : toSummaryDto(manifest);
      },
    ),
  );

  bus.handle(
    IPC_CHANNELS.revisionRestore,
    handleRequest(
      parseRevisionRestoreInput,
      async (input): Promise<RevisionRestoreResult> => {
        const root = await resolveVaultRoot(input.vaultId, deps);
        assertWritable(root.transient);
        // 定位 series 并读历史快照（缺失/损坏一样拒绝，不写任何字节）。
        const seriesId = await findSeriesId(root.absolutePath, {
          stableNoteId: input.stableNoteId ?? null,
          relativePath: input.relativePath,
        });
        const snapshot =
          seriesId === null
            ? null
            : await new DesktopRevisionStore(root.absolutePath).get(
                seriesId,
                input.revisionId,
              );
        if (snapshot === null || snapshot.kind !== "ok") {
          throw new IpcFailure(
            "NOTE_NOT_FOUND",
            "该版本已不存在或无法读取，恢复已取消。",
          );
        }
        // 乐观锁预检（§23 并发规则）：磁盘令牌与 Renderer 持有人认为的
        // 当前版本不一致 → DOCUMENT_CONFLICT，不写任何字节；
        // atomicWriteFile 落盘前还会复核一次（防 TOCTOU）。
        const current = await readNoteFile({
          vaultRoot: root.absolutePath,
          relativePath: input.relativePath,
        });
        if (current.versionToken !== input.expectedVersionToken) {
          throw new IpcFailure(
            "DOCUMENT_CONFLICT",
            "这篇笔记已在 E1 之外发生修改，为避免覆盖外部修改，版本恢复已取消。",
          );
        }
        // REV-02/REV-03：历史 raw body 逐字节拼回（不经 MarkdownCodec
        // 重序列化）；当前 Frontmatter 原样保留（含未知字段），仅 updated
        // 推进到恢复时间；行尾跟随当前文件（splitFrontmatter 需 LF 输入，
        // 元数据解析用 LF 副本，重组时按原行尾展开）。
        const split = splitFrontmatter(current.markdown.replace(/\r\n/g, "\n"));
        const eol =
          detectLineEnding(current.markdown) === "crlf" ? "\r\n" : "\n";
        let nextMarkdown: string;
        if (split.hasFrontmatter) {
          const frontmatter = generateFrontmatter({
            ...split.metadata,
            updatedAt: new Date().toISOString(),
          });
          nextMarkdown =
            frontmatter.split("\n").join(eol) + eol + eol + snapshot.body;
        } else {
          // 无 Frontmatter 的文档（path-only 外部文档）：body 即全文。
          nextMarkdown = snapshot.body;
        }
        const written = await atomicWriteFile({
          targetPath: await resolveWithinVault(
            root.absolutePath,
            input.relativePath,
          ),
          bytes: new TextEncoder().encode(nextMarkdown),
          expectedVersionToken: input.expectedVersionToken,
        });
        // 自写登记：restore 落盘不触发 watcher 回声（编辑器重载由 Renderer
        // 侧恢复流程显式完成，不依赖 watcher）。
        deps.selfWrites?.record({
          vaultId: input.vaultId,
          relativePath: input.relativePath,
          versionToken: written.versionToken,
        });
        return {
          versionToken: written.versionToken,
          updatedAt: written.modifiedAt,
        };
      },
    ),
  );

  bus.handle(
    IPC_CHANNELS.revisionPrune,
    handleRequest(
      parseRevisionPruneInput,
      async (input): Promise<RevisionPruneResult> => {
        const root = await resolveVaultRoot(input.vaultId, deps);
        assertWritable(root.transient);
        const seriesId = await findSeriesId(root.absolutePath, {
          stableNoteId: input.stableNoteId ?? null,
          relativePath: input.relativePath,
        });
        if (seriesId === null) return { pruned: 0 };
        const store = new DesktopRevisionStore(root.absolutePath);
        // keep/maxBytes 缺省用 retention 策略常量（100 / 5MiB，§26）。
        const result = await pruneIntervalRevisions(
          store,
          seriesId,
          input.keep,
          input.maxBytes,
        );
        return { pruned: result.pruned.length };
      },
    ),
  );

  bus.handle(
    IPC_CHANNELS.revisionRelocate,
    handleRequest(
      parseRevisionRelocateInput,
      async (input): Promise<RevisionRelocateResult> => {
        const root = await resolveVaultRoot(input.vaultId, deps);
        assertWritable(root.transient);
        // §24：prefix=true 为分组 rename/move 的批量前缀语义；
        // 单文档按 stable-id 优先 → fromRelativePath 兜底定位。
        if (input.prefix === true) {
          const relocated = await relocateSeriesPrefix(
            root.absolutePath,
            input.fromRelativePath,
            input.toRelativePath,
          );
          return { relocated };
        }
        const hit = await relocateSeries(
          root.absolutePath,
          {
            ...(input.stableNoteId != null
              ? { stableNoteId: input.stableNoteId }
              : {}),
            fromRelativePath: input.fromRelativePath,
          },
          input.toRelativePath,
        );
        return { relocated: hit ? 1 : 0 };
      },
    ),
  );

  bus.handle(
    IPC_CHANNELS.revisionPurgeSeries,
    handleRequest(
      parseRevisionPurgeSeriesInput,
      async (input): Promise<RevisionPurgeSeriesResult> => {
        const root = await resolveVaultRoot(input.vaultId, deps);
        assertWritable(root.transient);
        // 定位优先级：seriesId 直给 > stable-id 派生 > path-only 路径匹配。
        let seriesId = input.seriesId ?? null;
        if (seriesId === null) {
          if (input.stableNoteId != null || input.relativePath !== undefined) {
            seriesId = await findSeriesId(root.absolutePath, {
              stableNoteId: input.stableNoteId ?? null,
              // path-only 兜底匹配需要当前路径；仅给了 stableNoteId 时
              // findSeriesId 走确定性派生，不读 relativePath。
              relativePath: input.relativePath ?? "",
            });
          }
        }
        if (seriesId === null) return { purged: false };
        const store = new DesktopRevisionStore(root.absolutePath);
        return { purged: await store.purgeSeries(seriesId) };
      },
    ),
  );
}
