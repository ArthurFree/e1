/**
 * 内存资源服务（R005 阶段 5）：AssetAccessService / AssetPicker /
 * NotificationService 的纯内存实现，供内存容器（createInMemoryAppServices）
 * 与单元测试使用——证明 Web 适配器（Object URL / input file / alert）
 * 可整体替换。
 *
 * - InMemoryAssetAccessService：读取委托内存 AssetStore；resolveUrl 产出
 *   `memory-asset://<id>` 伪 URL，releaseUrl/download 记录调用便于断言；
 * - StubAssetPicker：默认返回 null（用户取消语义），可经 nextPicked 预置选中文件；
 * - StubNotificationService：记录全部提示文案到 messages。
 */
import type {
  AssetAccessService,
  AssetPicker,
  NotificationService,
  PickedAsset,
} from "../../application/assets/assetServices";
import type { AssetStore } from "../../domain/repositories";
import type { Attachment, BinaryAttachment } from "../../domain/types";

export class InMemoryAssetAccessService implements AssetAccessService {
  /** 已释放的 URL（断言「即用即毁」语义用）。 */
  readonly releasedUrls: string[] = [];
  /** 已触发下载的资源 ID。 */
  readonly downloads: string[] = [];

  constructor(private readonly store: AssetStore) {}

  getMetadata(assetId: string): Promise<Attachment | undefined> {
    return this.store.getMetadata(assetId);
  }

  getBinary(assetId: string): Promise<BinaryAttachment | undefined> {
    return this.store.getBinary(assetId);
  }

  listByDocument(pageId: string): Promise<Attachment[]> {
    return this.store.listByDocument(pageId);
  }

  async resolveUrl(assetId: string): Promise<string | null> {
    const binary = await this.store.getBinary(assetId).catch(() => undefined);
    if (!binary || binary.data.byteLength === 0) return null;
    return `memory-asset://${assetId}`;
  }

  releaseUrl(url: string): void {
    this.releasedUrls.push(url);
  }

  async download(assetId: string): Promise<boolean> {
    const binary = await this.store.getBinary(assetId).catch(() => undefined);
    if (!binary || binary.data.byteLength === 0) return false;
    this.downloads.push(assetId);
    return true;
  }
}

export class StubAssetPicker implements AssetPicker {
  /** 预置的下一次选择结果；null 表示用户取消（默认）。 */
  nextPicked: PickedAsset | null = null;

  async pick(): Promise<PickedAsset | null> {
    return this.nextPicked;
  }
}

export class StubNotificationService implements NotificationService {
  readonly messages: string[] = [];

  notify(message: string): void {
    this.messages.push(message);
  }
}
