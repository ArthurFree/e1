/**
 * createManualRevision 手动版本捕获测试（R012 Stage 3，需求 §22/§34/§43）：
 * - reason 固定 "manual"，contentJson/textSnapshot 原样透传给仓储
 *  （Desktop 实现会忽略它们、以磁盘为准，REV-02）；
 * - 绕过 interval 节流（不经 shouldCreateIntervalRevision）；
 * - 去重命中（add 返回 null）按 null 透传，不当作失败；
 * - 失败必须让调用方感知：DomainError 原样透传，未知错误统一包装为
 *   DomainError("REVISION_CAPTURE_FAILED")（§43 手动 Snapshot 失败模型，
 *   不走 maintenance warning 降级）。
 */
import { describe, expect, it } from "vitest";
import type { RevisionRepository } from "../../domain/repositories";
import { DomainError } from "../../domain/errors";
import type { RevisionReason, RevisionSummary } from "../../domain/types";
import { createInMemoryRepositories } from "../../infrastructure/memory/repositories";
import { BrowserMemorySearchIndex } from "../../platform/web/search/BrowserMemorySearchIndex";
import { DocumentCommitService } from "../services/DocumentCommitService";
import { DocumentQueryService } from "../queries/DocumentQueryService";
import { DocumentCommandService } from "./DocumentCommandService";

const DOC = { type: "doc", content: [{ type: "paragraph" }] };

/** 以指定版本仓储装配 DocumentCommandService（其余依赖为内存真实实例）。 */
function makeService(revisions: RevisionRepository) {
  const repos = createInMemoryRepositories();
  const searchIndex = new BrowserMemorySearchIndex({
    pages: repos.page,
    content: repos.content,
  });
  const documentCommit = new DocumentCommitService({
    content: repos.content,
    documentWrite: repos.documentWrite,
    revisions: repos.revision,
    searchIndex,
  });
  const documentQueries = new DocumentQueryService({
    content: repos.content,
    revisions,
  });
  const service = new DocumentCommandService({
    documentCommit,
    documentQueries,
    revisions,
  });
  return { service, repos };
}

function makeSummary(createdAt: number, reason: RevisionReason): RevisionSummary {
  return {
    id: `r-${createdAt}`,
    pageId: "page-1",
    createdAt,
    reason,
    bytes: 16,
    textPreview: "预览",
  };
}

describe("createManualRevision", () => {
  it('以 "manual" reason 调用 add 并透传当前内容，返回新快照摘要', async () => {
    const calls: {
      pageId: string;
      json: unknown;
      text: string;
      reason: RevisionReason;
    }[] = [];
    const revisions: RevisionRepository = {
      async listByPage() {
        return [];
      },
      async get() {
        return undefined;
      },
      async add(pageId, json, text, reason) {
        calls.push({ pageId, json, text, reason });
        return makeSummary(Date.now(), reason);
      },
      async pruneInterval() {},
    };
    const { service } = makeService(revisions);

    const summary = await service.createManualRevision("page-1", DOC, "当前内容");

    expect(calls).toEqual([
      { pageId: "page-1", json: DOC, text: "当前内容", reason: "manual" },
    ]);
    expect(summary?.reason).toBe("manual");
  });

  it("绕过 interval 节流：远小于 5 分钟的连续手动创建都成功落库", async () => {
    const repos = createInMemoryRepositories();
    const { service } = makeService(repos.revision);
    const ws = await repos.workspace.create("知识库");
    const page = await repos.page.create({
      workspaceId: ws.id,
      parentId: null,
      kind: "document",
      title: "文档",
    });

    // 真实内存仓储：连续两次手动创建（内容不同），均不受 5 分钟间隔限制。
    const first = await service.createManualRevision(page.id, DOC, "第一版");
    const second = await service.createManualRevision(
      page.id,
      { type: "doc", content: [{ type: "paragraph" }, { type: "paragraph" }] },
      "第二版",
    );
    expect(first?.reason).toBe("manual");
    expect(second?.reason).toBe("manual");
    expect(second?.id).not.toBe(first?.id);

    const list = await repos.revision.listByPage(page.id);
    expect(list.map((r) => r.reason)).toEqual(["manual", "manual"]);
  });

  it("去重命中（add 返回 null）按 null 透传，不当作失败", async () => {
    const revisions: RevisionRepository = {
      async listByPage() {
        return [];
      },
      async get() {
        return undefined;
      },
      async add() {
        return null;
      },
      async pruneInterval() {},
    };
    const { service } = makeService(revisions);

    await expect(
      service.createManualRevision("page-1", DOC, "与最新快照一致"),
    ).resolves.toBeNull();
  });

  it("仓储抛 DomainError 时原样透传（保留原错误码）", async () => {
    const revisions: RevisionRepository = {
      async listByPage() {
        return [];
      },
      async get() {
        return undefined;
      },
      async add() {
        throw new DomainError("VAULT_READ_ONLY", "仅预览知识库不可写。");
      },
      async pruneInterval() {},
    };
    const { service } = makeService(revisions);

    await expect(
      service.createManualRevision("page-1", DOC, "内容"),
    ).rejects.toMatchObject({
      name: "DomainError",
      code: "VAULT_READ_ONLY",
    });
  });

  it('仓储抛未知错误时包装为 DomainError("REVISION_CAPTURE_FAILED")', async () => {
    const revisions: RevisionRepository = {
      async listByPage() {
        return [];
      },
      async get() {
        return undefined;
      },
      async add() {
        throw new Error("capture IPC 失败");
      },
      async pruneInterval() {},
    };
    const { service } = makeService(revisions);

    const failure = await service
      .createManualRevision("page-1", DOC, "内容")
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(failure).toBeInstanceOf(DomainError);
    expect((failure as DomainError).code).toBe("REVISION_CAPTURE_FAILED");
    expect((failure as DomainError).message).toContain("创建版本失败");
    expect((failure as DomainError).details?.cause).toBe("capture IPC 失败");
  });
});
