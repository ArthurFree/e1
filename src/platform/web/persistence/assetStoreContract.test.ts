/**
 * AssetStore 契约——IndexedDB 实现（R005 阶段 5）。
 * 契约断言见 src/test/assetStoreContract.ts（与内存实现共用）。
 */
import { beforeEach } from "vitest";
import { describeAssetStoreContract } from "../../../test/assetStoreContract";
import { resetDB } from "./db";
import { assetStore } from "./repositories";

beforeEach(async () => {
  await resetDB();
});

describeAssetStoreContract("IndexedDB", () => assetStore);
