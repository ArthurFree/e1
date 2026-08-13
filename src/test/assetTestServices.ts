/**
 * 测试用资源服务装配（R005 阶段 5）：编辑器扩展测试经
 * editor.storage.assetServices 注入的服务组——IndexedDB assetStore
 * （fake-indexeddb）+ 生产 Web 适配器（URL.createObjectURL 等由
 * 各测试按需 stub）；picker 默认取消（null），测试可覆盖。
 */
import { AssetCommandService } from "../application/assets/AssetCommandService";
import type {
  AssetPicker,
  AssetServices,
} from "../application/assets/assetServices";
import { WebAssetAccessService } from "../platform/web/webAssetAccess";
import { WebNotificationService } from "../platform/web/webNotification";
import { assetStore } from "../platform/web/persistence/repositories";

export function createTestAssetServices(
  overrides: Partial<AssetServices> = {},
): AssetServices {
  const picker: AssetPicker = { pick: async () => null };
  return {
    commands: new AssetCommandService({ store: assetStore }),
    access: new WebAssetAccessService(assetStore),
    picker,
    notify: new WebNotificationService(),
    ...overrides,
  };
}
