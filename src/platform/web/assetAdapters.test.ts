/**
 * Web 资源适配器测试（R005 阶段 5）：
 * - WebAssetAccessService：resolveUrl/releaseUrl 生命周期（Object URL
 *   即用即毁）、缺失/空资源返回 null、download 经 a[download] 触发；
 * - WebAssetPicker：cancel 返回 null、选中文件读出字节、accept 透传；
 * - WebNotificationService：暂以 window.alert 实现（行为不变）。
 * Blob 只存在于本适配层：存储侧为内存 AssetStore（Uint8Array）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInMemoryRepositories,
  createMemoryStore,
} from "../../infrastructure/memory/repositories";
import { WebAssetAccessService } from "./webAssetAccess";
import { WebAssetPicker } from "./webAssetPicker";
import { WebNotificationService } from "./webNotification";

function setup() {
  const repos = createInMemoryRepositories(createMemoryStore());
  const access = new WebAssetAccessService(repos.assetStore);
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

describe("WebAssetAccessService", () => {
  beforeEach(() => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:mock-url"),
      revokeObjectURL: vi.fn(),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resolveUrl 由字节重建 Blob 创建 Object URL，releaseUrl 释放", async () => {
    const { repos, access } = setup();
    const record = await seed(repos);
    const url = await access.resolveUrl(record.id);
    expect(url).toBe("blob:mock-url");
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBe(2);

    access.releaseUrl(url!);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });

  it("资源缺失或为空：resolveUrl 返回 null、download 返回 false", async () => {
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
  });

  it("download 经 a[download] 触发并及时 revoke", async () => {
    const { repos, access } = setup();
    const record = await seed(repos);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    expect(await access.download(record.id)).toBe(true);
    expect(click).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });

  it("getBinary/getMetadata/listByDocument 委托存储", async () => {
    const { repos, access } = setup();
    const record = await seed(repos);
    expect(await access.getMetadata(record.id)).toEqual(record);
    expect([...((await access.getBinary(record.id))?.data ?? [])]).toEqual([
      1, 2,
    ]);
    expect(await access.listByDocument("page-1")).toEqual([record]);
  });
});

describe("WebAssetPicker", () => {
  it("用户取消（cancel 事件）resolve null，input 从 DOM 移除", async () => {
    const picker = new WebAssetPicker();
    const promise = picker.pick({ accept: "image/png" });
    const input =
      document.body.querySelector<HTMLInputElement>("input[type=file]");
    expect(input).not.toBeNull();
    expect(input!.accept).toBe("image/png");
    input!.dispatchEvent(new Event("cancel"));
    await expect(promise).resolves.toBeNull();
    expect(document.body.querySelector("input[type=file]")).toBeNull();
  });

  it("选中文件：读出字节返回 PickedAsset", async () => {
    const picker = new WebAssetPicker();
    const promise = picker.pick();
    const input =
      document.body.querySelector<HTMLInputElement>("input[type=file]")!;
    const file = new File([new Uint8Array([9, 8])], "a.txt", {
      type: "text/plain",
    });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));
    const picked = await promise;
    expect(picked?.name).toBe("a.txt");
    expect(picked?.mimeType).toBe("text/plain");
    expect(picked?.size).toBe(2);
    expect([...(picked?.data ?? [])]).toEqual([9, 8]);
  });

  it("change 但无文件：resolve null", async () => {
    const picker = new WebAssetPicker();
    const promise = picker.pick();
    const input =
      document.body.querySelector<HTMLInputElement>("input[type=file]")!;
    Object.defineProperty(input, "files", { value: [] });
    input.dispatchEvent(new Event("change"));
    await expect(promise).resolves.toBeNull();
  });
});

describe("WebNotificationService", () => {
  it("经 window.alert 提示（行为不变，后续可替换 toast）", () => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    new WebNotificationService().notify("出错了");
    expect(alert).toHaveBeenCalledWith("出错了");
    alert.mockRestore();
  });
});
