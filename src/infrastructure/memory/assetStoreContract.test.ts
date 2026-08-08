/**
 * AssetStore 契约——内存实现（R005 阶段 5）。
 * 契约断言见 src/test/assetStoreContract.ts（与 IndexedDB 实现共用）。
 */
import { describeAssetStoreContract } from "../../test/assetStoreContract";
import { createInMemoryRepositories, createMemoryStore } from "./repositories";

describeAssetStoreContract(
  "内存",
  () => createInMemoryRepositories(createMemoryStore()).assetStore,
);
