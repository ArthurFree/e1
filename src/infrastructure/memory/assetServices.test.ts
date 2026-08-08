/**
 * 内存资源服务测试（R005 阶段 5）：
 * - InMemoryAssetAccessService：resolveUrl 伪 URL 生命周期与 release/download 记录；
 * - StubAssetPicker：默认取消（null）与预置选中；
 * - StubNotificationService：记录提示文案。
 */
import { describe, expect, it } from "vitest";
import { createInMemoryRepositories, createMemoryStore } from "./repositories";
import {
  InMemoryAssetAccessService,
  StubAssetPicker,
  StubNotificationService,
} from "./assetServices";

function setup() {
  const repos = createInMemoryRepositories(createMemoryStore());
  const access = new InMemoryAssetAccessService(repos.assetStore);
  return { repos, access };
}

async function seed(repos: ReturnType<typeof setup>["repos"]) {
  return repos.assetStore.add({
    pageId: "page-1",
    name: "图.png",
    mimeType: "image/png",
    size: 2,
    data: new Uint8Array([1, 2]),
  });
}

describe("InMemoryAssetAccessService", () => {
  it("resolveUrl 产出伪 URL，releaseUrl 记录释放", async () => {
    const { repos, access } = setup();
    const record = await seed(repos);
    const url = await access.resolveUrl(record.id);
    expect(url).toBe(`memory-asset://${record.id}`);
    access.releaseUrl(url!);
    expect(access.releasedUrls).toEqual([url]);
  });

  it("资源缺失或为空时 resolveUrl 返回 null、download 返回 false", async () => {
    const { repos, access } = setup();
    expect(await access.resolveUrl("missing")).toBeNull();
    expect(await access.download("missing")).toBe(false);
    const empty = await repos.assetStore.add({
      pageId: "page-1",
      name: "空.txt",
      mimeType: "text/plain",
      size: 0,
      data: new Uint8Array(0),
    });
    expect(await access.resolveUrl(empty.id)).toBeNull();
    expect(await access.download(empty.id)).toBe(false);
    expect(access.downloads).toEqual([]);
  });

  it("download 成功记录资源 ID 并返回 true", async () => {
    const { repos, access } = setup();
    const record = await seed(repos);
    expect(await access.download(record.id)).toBe(true);
    expect(access.downloads).toEqual([record.id]);
  });
});

describe("StubAssetPicker / StubNotificationService", () => {
  it("picker 默认返回 null（用户取消），可预置选中文件", async () => {
    const picker = new StubAssetPicker();
    expect(await picker.pick()).toBeNull();
    picker.nextPicked = {
      name: "a.txt",
      mimeType: "text/plain",
      size: 1,
      data: new Uint8Array([1]),
    };
    expect((await picker.pick())?.name).toBe("a.txt");
  });

  it("notification 记录全部提示文案", () => {
    const notify = new StubNotificationService();
    notify.notify("第一条");
    notify.notify("第二条");
    expect(notify.messages).toEqual(["第一条", "第二条"]);
  });
});
