/**
 * ContentRepository 乐观并发契约——内存实现（R004 阶段 7；R005 阶段 3 令牌化）。
 * 契约断言见 src/test/contentSaveContract.ts（与 IndexedDB 实现共用）。
 */
import { describeContentSaveContract } from "../../test/contentSaveContract";
import {
  createInMemoryRepositories,
  createMemoryStore,
  type StoredMemoryContent,
} from "./repositories";

describeContentSaveContract("内存", () => {
  const store = createMemoryStore();
  const repos = createInMemoryRepositories(store);
  return {
    workspace: repos.workspace,
    page: repos.page,
    content: repos.content,
    async seedLegacyContent(pageId, workspaceId) {
      // 模拟 R004 阶段 7 之前的存量记录（内部无 version 字段）。
      const legacy: StoredMemoryContent = {
        pageId,
        workspaceId,
        contentJson: { type: "doc", content: [] },
        textSnapshot: "旧",
        updatedAt: Date.now(),
      };
      store.contents.set(pageId, legacy);
    },
  };
});
