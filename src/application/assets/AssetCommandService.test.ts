/**
 * AssetCommandService 单元测试（R005 阶段 5）：
 * - importAsset 成功路径：校验通过后落 AssetStore，返回纯元数据；
 * - 校验失败路径（超大/图片 MIME 白名单/总量超限）：抛 DomainError 且不写存储；
 * - 存储错误（配额不足）原样透传，isQuotaExceededError 可判定；
 * - removeAsset / removeOrphans 委托语义。
 * 存储用内存 AssetStore，不依赖 IndexedDB。
 */
import { describe, expect, it, vi } from "vitest";
import { isDomainError, isQuotaExceededError } from "../../domain/errors";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_DOCUMENT_ATTACHMENT_BYTES,
} from "../../domain/attachments";
import {
  createInMemoryRepositories,
  createMemoryStore,
} from "../../infrastructure/memory/repositories";
import {
  AssetCommandService,
  type ImportAssetInput,
} from "./AssetCommandService";

function setup() {
  const repos = createInMemoryRepositories(createMemoryStore());
  const commands = new AssetCommandService({ store: repos.assetStore });
  return { repos, commands };
}

function input(overrides: Partial<ImportAssetInput> = {}): ImportAssetInput {
  return {
    pageId: "page-1",
    name: "说明.txt",
    mimeType: "text/plain",
    size: 3,
    data: new Uint8Array([1, 2, 3]),
    ...overrides,
  };
}

describe("AssetCommandService.importAsset", () => {
  it("合法输入写入存储并返回元数据", async () => {
    const { repos, commands } = setup();
    const record = await commands.importAsset(input());
    expect(record.name).toBe("说明.txt");
    expect(await repos.assetStore.getMetadata(record.id)).toEqual(record);
    const binary = await repos.assetStore.getBinary(record.id);
    expect([...(binary?.data ?? [])]).toEqual([1, 2, 3]);
  });

  it("超过单附件上限：抛 ATTACHMENT_TOO_LARGE 且不写存储", async () => {
    const { repos, commands } = setup();
    await expect(
      commands.importAsset(input({ size: MAX_ATTACHMENT_BYTES + 1 })),
    ).rejects.toSatisfy((e) => isDomainError(e, "ATTACHMENT_TOO_LARGE"));
    expect(await repos.assetStore.listByDocument("page-1")).toEqual([]);
  });

  it("图片路径 MIME 白名单：非白名单抛 UNSUPPORTED_ATTACHMENT_TYPE", async () => {
    const { commands } = setup();
    await expect(
      commands.importAsset(
        input({ mimeType: "image/tiff", requireImage: true }),
      ),
    ).rejects.toSatisfy((e) => isDomainError(e, "UNSUPPORTED_ATTACHMENT_TYPE"));
    await expect(
      commands.importAsset(
        input({ mimeType: "image/png", requireImage: true }),
      ),
    ).resolves.toMatchObject({ mimeType: "image/png" });
  });

  it("单文档总量校验计入既有附件", async () => {
    const { repos, commands } = setup();
    // 直接落库一条贴近总量上限的记录（绕过导入校验），再导入即超限。
    await repos.assetStore.add(
      input({ size: MAX_DOCUMENT_ATTACHMENT_BYTES - 1024 }),
    );
    await expect(commands.importAsset(input({ size: 2048 }))).rejects.toSatisfy(
      (e) => isDomainError(e, "ATTACHMENT_TOO_LARGE"),
    );
  });

  it("存储配额错误原样透传（isQuotaExceededError 可判定）", async () => {
    const { repos, commands } = setup();
    const spy = vi
      .spyOn(repos.assetStore, "add")
      .mockRejectedValue(new DOMException("quota", "QuotaExceededError"));
    await expect(commands.importAsset(input())).rejects.toSatisfy((e) =>
      isQuotaExceededError(e),
    );
    spy.mockRestore();
  });
});

describe("AssetCommandService.removeAsset / removeOrphans", () => {
  it("removeAsset 删除记录", async () => {
    const { repos, commands } = setup();
    const record = await commands.importAsset(input());
    await commands.removeAsset(record.id);
    expect(await repos.assetStore.getMetadata(record.id)).toBeUndefined();
  });

  it("removeOrphans 清理未引用附件并返回数量", async () => {
    const { repos, commands } = setup();
    const keep = await commands.importAsset(input({ name: "保留.txt" }));
    await commands.importAsset(input({ name: "孤儿.txt" }));
    const removed = await commands.removeOrphans("page-1", [keep.id]);
    expect(removed).toBe(1);
    expect(
      (await repos.assetStore.listByDocument("page-1")).map((a) => a.id),
    ).toEqual([keep.id]);
  });
});
