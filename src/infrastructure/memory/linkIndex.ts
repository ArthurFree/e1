/**
 * R010 Stage 3（§6/§11）：LinkIndex 的内存参照实现——
 * 契约语义的基准（与 Desktop SQLite 实现跑同一套契约套件，
 * shared/links/linkIndexContract.ts）。
 *
 * 目标解析/broken 裁决委托 shared/links/resolveLinks 的冻结实现
 *（resolveExtractedLinks），与 SQLite 实现逐点一致；
 * 纯内存 Map，不触碰浏览器/Node API。
 *
 * upsert 是读盘语义（DSK-02 同口径）：实现经构造注入的 source 按
 * vaultId + relativePath 自取文档；内存容器无磁盘，由调用方供给
 * source（测试经契约 ctx.putDocument 维护）。
 */
import type {
  LinkIndex,
  LinkIndexDocument,
} from "../../application/links/LinkIndex";
import type { DocumentLink, Backlink } from "../../application/links/LinkIndex";
import type { SearchIndexStatus } from "../../application/search/SearchIndexStatus";
import {
  resolveExtractedLinks,
  type LinkIndexLookup,
} from "../../../shared/links/resolveLinks";
import { buildExtractedLink } from "../../../shared/links/extractDocumentLinks";

/** upsert 的文档来源（「磁盘」抽象）；返回 null 表示文件已消失。 */
export interface LinkIndexDocumentSource {
  read(vaultId: string, relativePath: string): LinkIndexDocument | null;
}

interface StoredDoc {
  document: LinkIndexDocument;
  /** 已解析的出站链接行（顺序与提取一致）。 */
  links: DocumentLink[];
}

export class InMemoryLinkIndex implements LinkIndex {
  private readonly byVault = new Map<string, Map<string, StoredDoc>>();
  private readonly status = new Map<string, SearchIndexStatus>();

  constructor(private readonly source?: LinkIndexDocumentSource) {}

  private bucket(vaultId: string): Map<string, StoredDoc> {
    let bucket = this.byVault.get(vaultId);
    if (!bucket) {
      bucket = new Map();
      this.byVault.set(vaultId, bucket);
    }
    return bucket;
  }

  private lookup(vaultId: string): LinkIndexLookup {
    const bucket = this.byVault.get(vaultId);
    return {
      byPath: (relativePath) => {
        if (!bucket) return null;
        for (const stored of bucket.values()) {
          if (stored.document.relativePath === relativePath) {
            return {
              noteKey: stored.document.noteKey,
              relativePath: stored.document.relativePath,
            };
          }
        }
        return null;
      },
      byKey: (noteKey) => {
        const stored = bucket?.get(noteKey);
        return stored
          ? {
              noteKey: stored.document.noteKey,
              relativePath: stored.document.relativePath,
            }
          : null;
      },
    };
  }

  /** upsert 内核：替换文档 + 重解析出站 + 目标到达的 broken 恢复。 */
  private applyUpsert(document: LinkIndexDocument): void {
    const bucket = this.bucket(document.vaultId);
    const existing = bucket.get(document.noteKey);
    if (
      existing &&
      existing.document.versionToken === document.versionToken &&
      existing.document.relativePath === document.relativePath
    ) {
      return; // versionToken 未变的重复提交跳过（§12.3 同口径）。
    }
    bucket.set(document.noteKey, {
      document,
      links: resolveExtractedLinks(
        document,
        document.links,
        this.lookup(document.vaultId),
      ),
    });
    // 恢复：此前指向本路径的 broken 链接随目标到达翻回。
    for (const stored of bucket.values()) {
      for (const row of stored.links) {
        if (row.broken && row.targetRelativePath === document.relativePath) {
          row.targetPageId = document.noteKey;
          row.broken = false;
        }
      }
    }
    this.status.set(document.vaultId, {
      state: "ready",
      indexedDocuments: bucket.size,
    });
  }

  async rebuild(
    vaultId: string,
    documents?: Iterable<LinkIndexDocument> | AsyncIterable<LinkIndexDocument>,
  ): Promise<void> {
    if (!documents) {
      throw new Error("内存实现需要调用方供给 documents（真实数据源快照）");
    }
    this.status.set(vaultId, { state: "building" });
    const list: LinkIndexDocument[] = [];
    const bucket = new Map<string, StoredDoc>();
    this.byVault.set(vaultId, bucket);
    // 两遍：先登记全部文档（快照），再统一解析（目标可能后出现）。
    for await (const document of toAsyncIterable(documents)) {
      bucket.set(document.noteKey, { document, links: [] });
      list.push(document);
    }
    for (const document of list) {
      bucket.get(document.noteKey)!.links = resolveExtractedLinks(
        document,
        document.links,
        this.lookup(vaultId),
      );
    }
    this.status.set(vaultId, {
      state: "ready",
      indexedDocuments: bucket.size,
    });
  }

  upsert(input: {
    vaultId: string;
    relativePath: string;
  }): Promise<{ indexed: boolean }> {
    const document = this.source?.read(input.vaultId, input.relativePath);
    if (!document) return Promise.resolve({ indexed: false });
    this.applyUpsert(document);
    return Promise.resolve({ indexed: true });
  }

  remove(input: {
    vaultId: string;
    noteKey?: string;
    relativePath?: string;
  }): Promise<void> {
    const bucket = this.byVault.get(input.vaultId);
    if (!bucket) return Promise.resolve();
    const key =
      input.noteKey ?? this.findKeyByPath(bucket, input.relativePath ?? "");
    if (!key || !bucket.has(key)) return Promise.resolve();
    bucket.delete(key);
    // 指向被删文档的链接翻 broken（targetRelativePath 保留供恢复）。
    for (const stored of bucket.values()) {
      for (const row of stored.links) {
        if (row.targetPageId === key) {
          row.targetPageId = null;
          row.broken = true;
        }
      }
    }
    this.status.set(input.vaultId, {
      state: "ready",
      indexedDocuments: bucket.size,
    });
    return Promise.resolve();
  }

  relocate(input: {
    vaultId: string;
    noteKey?: string;
    fromRelativePath: string;
    toRelativePath: string;
  }): Promise<void> {
    const bucket = this.byVault.get(input.vaultId);
    if (!bucket) return Promise.resolve();
    const oldKey =
      input.noteKey ?? this.findKeyByPath(bucket, input.fromRelativePath);
    const stored = oldKey ? bucket.get(oldKey) : undefined;
    if (!stored || !oldKey) return Promise.resolve();
    const newKey =
      stored.document.stableNoteId ?? `path:${input.toRelativePath}`;
    // 指向本文件的链接随移动更新；broken 链接若正等新位置落位则恢复。
    for (const other of bucket.values()) {
      for (const row of other.links) {
        if (row.targetPageId === oldKey) {
          row.targetPageId = newKey;
          row.targetRelativePath = input.toRelativePath;
          row.broken = false;
        } else if (
          row.broken &&
          row.targetRelativePath === input.toRelativePath
        ) {
          row.targetPageId = newKey;
          row.broken = false;
        }
      }
    }
    // 源文档：身份保持（path 身份改键），出站链接按新位置重锚定。
    bucket.delete(oldKey);
    stored.document = {
      ...stored.document,
      noteKey: newKey,
      relativePath: input.toRelativePath,
    };
    bucket.set(newKey, stored);
    // 重锚定：相对 href 以新目录为基准重跑提取器归一（buildExtractedLink）；
    // Editor 节点引用（href=""，knownTargetPageId 身份）不受移动影响。
    const lookup = this.lookup(input.vaultId);
    const reanchored = stored.document.links.map((extracted) => {
      if (extracted.href === "") return extracted;
      return (
        buildExtractedLink(
          extracted.href,
          extracted.label,
          input.toRelativePath,
        ) ?? extracted
      );
    });
    stored.links = resolveExtractedLinks(stored.document, reanchored, lookup);
    return Promise.resolve();
  }

  getOutgoing(input: {
    vaultId: string;
    noteKey: string;
  }): Promise<DocumentLink[]> {
    const stored = this.byVault.get(input.vaultId)?.get(input.noteKey);
    return Promise.resolve(stored ? stored.links.map((l) => ({ ...l })) : []);
  }

  getBacklinks(input: {
    vaultId: string;
    noteKey: string;
  }): Promise<Backlink[]> {
    const bucket = this.byVault.get(input.vaultId);
    if (!bucket) return Promise.resolve([]);
    const backlinks: Backlink[] = [];
    for (const stored of bucket.values()) {
      for (const row of stored.links) {
        if (row.targetPageId !== input.noteKey || row.broken) continue;
        backlinks.push({
          sourcePageId: stored.document.noteKey,
          targetPageId: input.noteKey,
          sourceTitle: stored.document.title,
          snippet: null,
          href: row.href,
        });
      }
    }
    backlinks.sort(
      (a, b) =>
        compareText(a.sourcePageId, b.sourcePageId) ||
        compareText(a.href, b.href),
    );
    return Promise.resolve(backlinks);
  }

  getBrokenLinks(vaultId: string): Promise<DocumentLink[]> {
    const bucket = this.byVault.get(vaultId);
    if (!bucket) return Promise.resolve([]);
    const broken: DocumentLink[] = [];
    for (const stored of bucket.values()) {
      for (const row of stored.links) {
        if (row.broken) broken.push({ ...row });
      }
    }
    return Promise.resolve(broken);
  }

  getStatus(vaultId: string): SearchIndexStatus {
    return this.status.get(vaultId) ?? { state: "missing" };
  }

  /** 内存实现无外部触发源：rebuild 即准备（调用方供给 documents 时）。 */
  prepare(): Promise<void> {
    return Promise.resolve();
  }

  private findKeyByPath(
    bucket: Map<string, StoredDoc>,
    relativePath: string,
  ): string | null {
    for (const stored of bucket.values()) {
      if (stored.document.relativePath === relativePath) {
        return stored.document.noteKey;
      }
    }
    return null;
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function* toAsyncIterable<T>(
  documents: Iterable<T> | AsyncIterable<T>,
): AsyncIterable<T> {
  for await (const document of documents) {
    yield document;
  }
}
