/**
 * R006-C4.1-A（FR-01~06）：Desktop Markdown 写入唯一实现。
 *
 * ContentRepository.save 与 DocumentWriteRepository.replaceContent
 * 共用本服务——Source/Identity/Output Gate、Frontmatter 保留、Mention
 * 解析、note.save、versionToken 更新只存在一份。
 */
import { relativeVaultPath } from "../../../shared/markdown/relativePath";
import { DomainError } from "../../domain/errors";
import type { ContentVersionToken } from "../../domain/types";
import { createMarkdownCodec } from "../../editor/markdown/codec";
import type { MarkdownCodec } from "../../editor/markdown/types";
import type { PortableNoteMetadata } from "../../editor/markdown/types";
import type { E1DesktopAPI } from "./desktopApi";
import { DesktopIpcError } from "./desktopApi";
import type { DesktopDocumentSourceCache } from "./DesktopDocumentSourceCache";
import type { DesktopVaultScanCache } from "./DesktopVaultScanCache";
import type { DesktopAssetRegistry } from "./DesktopAssetRegistry";

export type DesktopMarkdownWriteMode = "autosave" | "replace-content";

export interface DesktopMarkdownWriteInput {
  pageId: string;
  contentJson: unknown;
  expectedVersionToken: ContentVersionToken;
  mode: DesktopMarkdownWriteMode;
}

export interface DesktopMarkdownWriteResult {
  versionToken: ContentVersionToken;
  updatedAt: number;
  serializedMarkdown: string;
}

export class DesktopMarkdownWriteService {
  constructor(
    private readonly api: E1DesktopAPI,
    private readonly sources: DesktopDocumentSourceCache,
    private readonly scans: DesktopVaultScanCache,
    private readonly codec: MarkdownCodec = createMarkdownCodec(),
    private readonly assets?: DesktopAssetRegistry,
  ) {}

  async save(
    input: DesktopMarkdownWriteInput,
  ): Promise<DesktopMarkdownWriteResult> {
    const ctx = this.sources.get(input.pageId);
    if (!ctx) {
      throw new DomainError(
        "DOCUMENT_SOURCE_CONTEXT_REQUIRED",
        "该文档的本地来源信息已经失效，请重新打开后再执行内容替换。",
      );
    }
    if (ctx.compatibility.lossy && !ctx.writeSession.sourceLossyApproved) {
      throw new DomainError(
        "MARKDOWN_LOSSY_OUTPUT",
        "当前 Markdown 包含 E1 暂不完全支持的格式，请先确认了解风险后再保存。",
        { phase: "source", unsupported: ctx.compatibility.unsupported },
      );
    }
    if (!ctx.stableNoteId && !ctx.writeSession.identityAdoptionApproved) {
      throw new DomainError(
        "MARKDOWN_LOSSY_OUTPUT",
        "这篇 Markdown 尚未建立稳定笔记身份，请先启用编辑后再保存。",
        { phase: "identity-adoption" },
      );
    }

    const metadata: PortableNoteMetadata = {
      ...ctx.metadata,
      id: ctx.stableNoteId ?? ctx.metadata.id,
      updatedAt: new Date().toISOString(),
      extra: ctx.frontmatterExtra,
    };

    const serialized = await this.codec.serialize({
      document: input.contentJson,
      metadata,
      assetResolver: {
        resolveAssetPath: ({ attachmentId, name }) =>
          this.resolveAssetRelativePath(
            ctx.vaultId,
            ctx.relativePath,
            attachmentId,
            name,
          ),
      },
      mode: "portable",
      lineEnding: ctx.lineEnding,
      resolveMentionPath: (targetPageId) =>
        this.resolveMentionRelativePath(
          ctx.vaultId,
          ctx.relativePath,
          targetPageId,
        ),
    });

    if (serialized.lossy && !ctx.writeSession.outputLossyApproved) {
      throw new DomainError(
        "MARKDOWN_LOSSY_OUTPUT",
        "当前内容包含 Markdown 无法完整表达的格式，自动保存已暂停。",
        { phase: "output", unsupported: serialized.unsupported },
      );
    }

    let saved;
    try {
      saved = await this.api.note.save({
        vaultId: ctx.vaultId,
        relativePath: ctx.relativePath,
        markdown: serialized.markdown,
        expectedVersionToken: input.expectedVersionToken,
      });
    } catch (err) {
      mapNoteWriteError(err);
    }

    this.sources.updateVersion(input.pageId, saved.versionToken);
    const latest = this.sources.get(input.pageId);
    if (latest) {
      this.sources.set(input.pageId, {
        ...latest,
        metadata: { ...latest.metadata, updatedAt: metadata.updatedAt },
        versionToken: saved.versionToken,
      });
    }
    return {
      versionToken: saved.versionToken,
      updatedAt: saved.source?.modifiedAt ?? Date.now(),
      serializedMarkdown: serialized.markdown,
    };
  }

  private resolveMentionRelativePath(
    vaultId: string,
    fromRelativePath: string,
    targetPageId: string,
  ): string | null {
    const target = this.scans.getRelativePathSync(vaultId, targetPageId);
    if (!target) return null;
    return relativeVaultPath(fromRelativePath, target);
  }

  private resolveAssetRelativePath(
    vaultId: string,
    fromRelativePath: string,
    attachmentId: string,
    name: string,
  ): string {
    const record = this.assets?.get(attachmentId);
    if (record) {
      return relativeVaultPath(fromRelativePath, record.relativePath);
    }
    const dir = this.scans.getAssetsDirectorySync(vaultId) ?? "assets";
    const file = name.split("/").pop() || "file";
    return relativeVaultPath(fromRelativePath, `${dir}/${file}`);
  }
}

/** note.save 的 IPC 错误 → DomainError（R006-C4 FR-10/11/15）。 */
export function mapNoteWriteError(err: unknown): never {
  if (err instanceof DesktopIpcError) {
    switch (err.code) {
      case "DOCUMENT_CONFLICT":
        throw new DomainError(
          "DOCUMENT_CONFLICT",
          "这篇笔记已在 E1 之外发生修改，为了避免覆盖外部修改，自动保存已暂停。",
          err.details,
        );
      case "VAULT_READ_ONLY":
        throw new DomainError(
          "VAULT_READ_ONLY",
          "当前知识库处于仅预览模式，E1 不会修改这个文件夹中的任何内容。",
        );
      case "NOTE_WRITE_PERMISSION_DENIED":
        throw new DomainError(
          "NOTE_WRITE_PERMISSION_DENIED",
          "无法保存 Markdown，当前系统用户没有该文件的写入权限。你的编辑内容仍保留在当前应用中。",
        );
      case "NOTE_WRITE_IO_ERROR":
        throw new DomainError(
          "NOTE_WRITE_IO_ERROR",
          "保存 Markdown 时发生系统错误，原文件没有被主动清空。",
        );
      case "DOCUMENT_TOO_LARGE":
        throw new DomainError(
          "DOCUMENT_TOO_LARGE",
          "这篇 Markdown 序列化结果过大，当前版本暂不支持保存。",
          err.details,
        );
      case "NOTE_NOT_FOUND":
        throw new DomainError(
          "PAGE_NOT_FOUND",
          "这篇笔记已经不存在。它可能已经被其他程序移动或删除。",
        );
      case "PATH_ESCAPE":
      case "INVALID_INPUT":
        throw new DomainError("INVALID_INPUT", err.message);
      default:
        throw err;
    }
  }
  throw err;
}

export function relativeMarkdownPath(fromFile: string, toFile: string): string {
  return relativeVaultPath(fromFile, toFile);
}
